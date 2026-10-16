// A disposable, LOCAL edge-runtime for the phone-upload functions
// (phone-upload-token: docs/selfhost-migration/phase-g/phone-upload-jit.md;
// phone-upload-page: docs/selfhost-migration/phase-f/phone-qr-origin.md), so
// the phone flow can be verified in the real UI WITHOUT deploying anything
// to the self-hosted stack.
//
//   * image: supabase/edge-runtime:v1.76.2 (the image the self-hosted stack runs);
//   * the upstream main router is copied READ-ONLY from the self-hosted stack
//     (volumes/functions/main/index.ts + deno.jsonc, plain code, no secrets)
//     into e2e/.results/edge-runtime/ (git-ignored) and bind-mounted, next to
//     the requested supabase/functions/<name> directories from this repo
//     (read-only);
//   * VERIFY_JWT=false locally (the self-hosted stack runs true; the anon key is an HS256
//     JWT that passes that gate, which needs JWT_SECRET we deliberately do
//     not copy here). The functions never rely on that gate. (On a stack
//     with VERIFY_JWT=true the page's unauthenticated GET needs a small
//     router allow-list change, kept with the deployment configuration; with
//     VERIFY_JWT=false locally the unpatched router serves it as is.);
//   * secrets: SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are passed as
//     `-e NAME` (name only) with the value in the docker CLI's environment -
//     never on a command line, in a file, or in a log;
//   * published on 127.0.0.1 only, random port; removed by stop().
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { liveCfg, PROJECT_ROOT, RESULTS_DIR } from "./env";

export const EDGE_RUNTIME_IMAGE = "supabase/edge-runtime:v1.76.2";

export type LocalFunctionName = "phone-upload-token" | "phone-upload-page";

export interface LocalFunctions {
  /** e.g. http://127.0.0.1:54123 (the router sees /<name> after the gateway's prefix rewrite) */
  base: string;
  /** e.g. http://127.0.0.1:54123/phone-upload-token */
  urlFor(name: LocalFunctionName): string;
  names: LocalFunctionName[];
  container: string;
  logs(): string;
  stop(): void;
}

function fetchRouterFromStackHost(dir: string): void {
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

/** Ready = the router can boot the function worker (first boot fetches npm deps into the container's deno cache). */
async function isReady(name: LocalFunctionName, url: string): Promise<boolean> {
  try {
    if (name === "phone-upload-token") {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "short" }) });
      await res.text();
      return res.status === 404; // the function's own generic "invalid link"
    }
    const res = await fetch(url);
    await res.text();
    return res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("text/html");
  } catch {
    return false; // not listening yet
  }
}

export async function startLocalFunctions(names: LocalFunctionName[], timeoutMs = 120_000): Promise<LocalFunctions> {
  if (!names.length) throw new Error("startLocalFunctions: no function requested");
  const cfg = liveCfg();
  const dir = path.join(RESULTS_DIR, "edge-runtime", "functions");
  fetchRouterFromStackHost(dir);
  const container = `spl-e2e-phone-upload-${process.pid}`;
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });

  const env = {
    ...process.env,
    SUPABASE_URL: cfg.url,
    SUPABASE_SERVICE_ROLE_KEY: cfg.serviceKey,
    SUPABASE_ANON_KEY: cfg.anonKey,
  };
  const mounts = names.flatMap((name) => ["-v", `${path.join(PROJECT_ROOT, "supabase", "functions", name)}:/home/deno/functions/${name}:ro`]);
  const run = spawnSync("docker", [
    "run", "-d", "--name", container,
    "-p", "127.0.0.1::9000",
    "-v", `${path.join(dir, "main")}:/home/deno/functions/main:ro`,
    "-v", `${path.join(dir, "deno.jsonc")}:/home/deno/functions/deno.jsonc:ro`,
    ...mounts,
    "-e", "SUPABASE_URL", "-e", "SUPABASE_SERVICE_ROLE_KEY", "-e", "SUPABASE_ANON_KEY",
    "-e", "VERIFY_JWT=false",
    EDGE_RUNTIME_IMAGE, "start", "--main-service", "/home/deno/functions/main",
  ], { env, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`docker run failed: ${redact(run.stderr)}`);

  const stop = () => { spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" }); };
  const logs = () => {
    const r = spawnSync("docker", ["logs", container], { encoding: "utf8" });
    return redact(`${r.stdout}${r.stderr}`);
  };
  try {
    const port = execFileSync("docker", ["port", container, "9000/tcp"], { encoding: "utf8" }).trim().split("\n")[0];
    const m = port.match(/^127\.0\.0\.1:(\d+)$/);
    if (!m) throw new Error(`unexpected published address "${port}" (must be 127.0.0.1 only)`);
    const base = `http://127.0.0.1:${m[1]}`;
    const urlFor = (name: LocalFunctionName) => {
      if (!names.includes(name)) throw new Error(`${name} is not served by this local runtime`);
      return `${base}/${name}`;
    };
    const deadline = Date.now() + timeoutMs;
    for (const name of names) {
      while (!(await isReady(name, urlFor(name)))) {
        if (Date.now() > deadline) throw new Error(`local ${name} not ready within ${timeoutMs} ms:\n${logs().slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return { base, urlFor, names, container, logs, stop };
  } catch (e) {
    stop();
    throw e;
  }
}
