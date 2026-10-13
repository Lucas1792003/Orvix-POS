// A disposable, LOCAL edge-runtime for the phone-upload-token function
// (docs/selfhost-migration/phase-g/phone-upload-jit.md), so the phone flow can
// be verified in the real UI WITHOUT deploying anything to lucashome.
//
//   * image: supabase/edge-runtime:v1.76.2 (the image lucashome runs);
//   * the upstream main router is copied READ-ONLY from lucashome
//     (volumes/functions/main/index.ts + deno.jsonc, plain code, no secrets)
//     into e2e/.results/edge-runtime/ (git-ignored) and bind-mounted, next to
//     supabase/functions/phone-upload-token from this repo (read-only);
//   * VERIFY_JWT=false locally (lucashome runs true; the anon key is an HS256
//     JWT that passes that gate, which needs JWT_SECRET we deliberately do
//     not copy here). The function itself never relies on that gate;
//   * secrets: SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are passed as
//     `-e NAME` (name only) with the value in the docker CLI's environment -
//     never on a command line, in a file, or in a log;
//   * published on 127.0.0.1 only, random port; removed by stop().
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { liveCfg, PROJECT_ROOT, RESULTS_DIR } from "./env";

export const EDGE_RUNTIME_IMAGE = "supabase/edge-runtime:v1.76.2";
const FUNCTION = "phone-upload-token";

export interface LocalFunction {
  /** e.g. http://127.0.0.1:54123/phone-upload-token (the path the router sees after the gateway's prefix rewrite) */
  url: string;
  container: string;
  logs(): string;
  stop(): void;
}

function fetchRouterFromLucashome(dir: string): void {
  const cfg = liveCfg();
  mkdirSync(path.join(dir, "main"), { recursive: true });
  for (const [remote, local] of [["main/index.ts", "main/index.ts"], ["deno.jsonc", "deno.jsonc"]]) {
    const text = execFileSync("ssh", ["-o", "BatchMode=yes", cfg.sshHost, `cat ${cfg.stackDir}/volumes/functions/${remote}`], { encoding: "utf8" });
    if (!text.trim()) throw new Error(`empty ${remote} from ${cfg.sshHost}`);
    writeFileSync(path.join(dir, local), text, "utf8");
  }
}

/** Redact anything that looks like a JWT before a log line leaves this module. */
const redact = (s: string) => s.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>");

export async function startLocalPhoneUploadFunction(timeoutMs = 120_000): Promise<LocalFunction> {
  const cfg = liveCfg();
  const dir = path.join(RESULTS_DIR, "edge-runtime", "functions");
  fetchRouterFromLucashome(dir);
  const container = `spl-e2e-${FUNCTION}-${process.pid}`;
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });

  const env = {
    ...process.env,
    SUPABASE_URL: cfg.url,
    SUPABASE_SERVICE_ROLE_KEY: cfg.serviceKey,
    SUPABASE_ANON_KEY: cfg.anonKey,
  };
  const run = spawnSync("docker", [
    "run", "-d", "--name", container,
    "-p", "127.0.0.1::9000",
    "-v", `${path.join(dir, "main")}:/home/deno/functions/main:ro`,
    "-v", `${path.join(dir, "deno.jsonc")}:/home/deno/functions/deno.jsonc:ro`,
    "-v", `${path.join(PROJECT_ROOT, "supabase", "functions", FUNCTION)}:/home/deno/functions/${FUNCTION}:ro`,
    "-e", "SUPABASE_URL", "-e", "SUPABASE_SERVICE_ROLE_KEY", "-e", "SUPABASE_ANON_KEY",
    "-e", "VERIFY_JWT=false",
    EDGE_RUNTIME_IMAGE, "start", "--main-service", "/home/deno/functions/main",
  ], { env, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`docker run failed: ${redact(run.stderr)}`);

  const stop = () => { spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" }); };
  const logs = () => redact(spawnSync("docker", ["logs", container], { encoding: "utf8" }).stdout + spawnSync("docker", ["logs", container], { encoding: "utf8" }).stderr);
  try {
    const port = execFileSync("docker", ["port", container, "9000/tcp"], { encoding: "utf8" }).trim().split("\n")[0];
    const m = port.match(/^127\.0\.0\.1:(\d+)$/);
    if (!m) throw new Error(`unexpected published address "${port}" (must be 127.0.0.1 only)`);
    const url = `http://127.0.0.1:${m[1]}/${FUNCTION}`;
    // Ready = the router can boot the function worker (first boot fetches
    // npm:@supabase/supabase-js into the container's deno cache).
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "short" }) });
        if (res.status === 404) break; // the function's own generic "invalid link"
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`local ${FUNCTION} not ready within ${timeoutMs} ms:\n${logs().slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { url, container, logs, stop };
  } catch (e) {
    stop();
    throw e;
  }
}
