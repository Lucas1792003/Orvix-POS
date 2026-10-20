import { describe, expect, it } from "vitest";
import { classifySubmitFailure } from "./submitOutcome";
import { outcomeToast } from "./outcomeToast";
import { getErrorMessage } from "./errors";
import { PendingConfirmationError, UnresolvedOperationError } from "../stores/data/operationPrompt";
import { RecoveryBlockedError } from "../stores/data/recoveryState";
import { RpcError } from "../stores/data/idempotentRpc";
import { failureInfo } from "./failureClass";

// The three outcomes a financial form must tell apart (v87.x store contract).
// Errors are the real classes the store throws.

const t = (section: string, key: string) => `${section}.${key}`;

describe("classifySubmitFailure", () => {
  it("unknown outcome → pending (close, never re-enter)", () => {
    expect(classifySubmitFailure(new PendingConfirmationError("Pending confirmation: …"))).toBe("pending");
    // crossing a window / structured clone keeps only the name
    expect(classifySubmitFailure({ name: "PendingConfirmationError", message: "x" })).toBe("pending");
  });

  it("an earlier attempt unresolved, nothing sent → not-sent (stay open)", () => {
    expect(classifySubmitFailure(new UnresolvedOperationError("An earlier attempt …", []))).toBe("not-sent");
  });

  it("confirmed failures → failed (stay open): recovery refusal, offline safeguard, server refusal, plain errors", () => {
    expect(classifySubmitFailure(new RecoveryBlockedError("hold", "RECOVERY_HOLD", "Not recorded — the server refused it: …"))).toBe("failed");
    expect(classifySubmitFailure(new RecoveryBlockedError("uncertain", "OFFLINE_FINANCIAL_DISABLED", "Not recorded — nothing was saved. …"))).toBe("failed");
    expect(classifySubmitFailure(new RpcError("Transfer already completed", { code: "P0001", failure: failureInfo("REJECTED") }))).toBe("failed");
    expect(classifySubmitFailure(new Error("Not sent: …"))).toBe("failed");
    expect(classifySubmitFailure(undefined)).toBe("failed");
  });

  it("agrees with outcomeToast's variant for every class", () => {
    const cases: [unknown, string][] = [
      [new PendingConfirmationError("p"), "warning"],
      [new UnresolvedOperationError("u", []), "info"],
      [new RecoveryBlockedError("hold", null, "Not recorded"), "error"],
      [new Error("e"), "error"],
    ];
    const variantFor = { pending: "warning", "not-sent": "info", failed: "error" } as const;
    for (const [err, variant] of cases) {
      expect(outcomeToast(err, t, "Failed", "Failed").variant).toBe(variant);
      expect(variantFor[classifySubmitFailure(err)]).toBe(variant);
    }
  });

  it("a recovery refusal keeps its explanation in the toast text", () => {
    const err = new RecoveryBlockedError("hold", "RECOVERY_HOLD", "Not recorded — the server refused it: server recovery in progress.");
    expect(getErrorMessage(err, "Failed")).toContain("Not recorded");
  });
});
