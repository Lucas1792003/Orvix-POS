// Regression guard (ORV-013, Step 6): Electron has no window.prompt() / confirm-style modal input — prompt() returns null at
// once, so any action that asks for a reason through it silently does nothing on the desktop app. Step 6 found it again in
// the cash-movement reversal (PFIN-D) and the supplier-payment void. Reasons are asked with components/ui/ReasonDialog.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

describe("no window.prompt in the app", () => {
  it("no source file calls prompt() (Electron does not implement it)", () => {
    const offenders = files(SRC).filter((f) => /(^|[^\w.])(window\.)?prompt\s*\(/.test(code(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
