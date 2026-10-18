// Area "ops" (migration 086 and later): the operation executor (op_execute)
// and the status lookup / fence (op_status) cannot cross organisations or
// actors. Org A's and B's ADMINs (aal2) and cashiers act on each other's
// keys; every effect is judged in the database. Recorded GAP (not a pass):
// a fence sent WITHOUT arguments carries no organisation evidence, so any
// user who knows another organisation's never-delivered key can claim it as
// their own (denial of service only; documented residual R3 — SQL proposal
// docs/selfhost-migration/phase-g/086-sql-proposals.md §1).
import { randomBytes } from "node:crypto";
import type { World } from "./seed";
import { applied, capture, check, gap, q, rpc, sql, sqlJson } from "./lib";

/** A UUIDv7 (time-ordered) key, as 086 clients mint them. */
function v7(): string {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const ledger = (key: string) => sql(`SELECT coalesce((SELECT state || '/' || coalesce(org_id, '') FROM idempotency_keys WHERE key = ${q(key)}::uuid), '<none>')`);
const movements = (org: string) => Number(sql(`SELECT count(*) FROM inventory_movements WHERE shop_id IN (SELECT id FROM shops WHERE org_id = ${q(org)})`));

export async function opsSuite(w: World) {
  if (!applied(86)) {
    check("ops", "migration 086 not applied at this level (suite skipped)", true, []);
    return;
  }
  const A = w.A, B = w.B;
  const adjustA = { p_shop_id: A.shops[0], p_product_id: A.products[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: `ops-${A.can}`,
    p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: A.people.admin.userId };
  const adjustB = { ...adjustA, p_shop_id: B.shops[0], p_product_id: B.products[0], p_reason: "ops-cross" };

  // 1. positive control: A's own operation runs once, for its own actor
  const kA = v7();
  const mA0 = movements(A.id);
  const own = await rpc(w.adminA2, "op_execute", { p_key: kA, p_rpc: "adjust_stock", p_args: adjustA, p_actor_id: A.people.admin.userId });
  check("ops", "positive: A ADMIN's own UUIDv7 operation commits through op_execute (once)", own.status < 300 && own.json?.outcome === "committed" && movements(A.id) === mA0 + 1,
    ["rpc:public.op_execute"], `status ${own.status} outcome ${own.json?.outcome}`);

  // 2. B looks up A's committed key: no state, no reply
  const look = await rpc(w.adminB2, "op_status", { p_key: kA, p_rpc: "adjust_stock", p_fence: false, p_expected_actor_id: null, p_args: null });
  capture("ops B op_status on A key", look.text, [kA]);
  check("ops", "op_status: B ADMIN learns nothing about A's committed key ('unavailable', no reply)", look.status < 300 && look.json?.status === "unavailable" && look.json?.response === undefined,
    ["rpc:public.op_status"], `status ${look.status} ${look.json?.status}`);

  // 3. B replays A's key: never A's reply, never an effect
  const mA1 = movements(A.id);
  const steal = await rpc(w.adminB2, "op_execute", { p_key: kA, p_rpc: "adjust_stock", p_args: adjustA, p_actor_id: B.people.admin.userId });
  capture("ops B op_execute with A key", steal.text, [kA]);
  check("ops", "op_execute: B reusing A's key gets no reply, no 'committed', no effect, and A's ledger row is unchanged",
    movements(A.id) === mA1 && steal.json?.outcome !== "committed" && steal.json?.response == null && ledger(kA) === `committed/${A.id}`,
    ["rpc:public.op_execute"], `status ${steal.status} ${steal.json?.outcome ?? steal.json?.message ?? ""} ledger ${ledger(kA)}`.slice(0, 160));

  // 4. A executes in the name of B's user: refused, nothing recorded
  const kX = v7();
  const asB = await rpc(w.adminA2, "op_execute", { p_key: kX, p_rpc: "adjust_stock", p_args: adjustA, p_actor_id: B.people.admin.userId });
  check("ops", "op_execute: A ADMIN cannot run an operation as B's user (OP_ACTOR_MISMATCH), nothing recorded", asB.status >= 300 && ledger(kX) === "<none>",
    ["rpc:public.op_execute"], `status ${asB.status} ${(asB.json?.message ?? "").slice(0, 60)} ledger ${ledger(kX)}`);

  // 5. A sends B's ids through the executor: refused, B unchanged
  const mB0 = movements(B.id);
  const kB = v7();
  const cross = await rpc(w.adminA2, "op_execute", { p_key: kB, p_rpc: "adjust_stock", p_args: adjustB, p_actor_id: A.people.admin.userId });
  capture("ops A op_execute with B ids", cross.text, [B.shops[0], B.products[0]]);
  check("ops", "op_execute: A ADMIN with B's ids changes nothing in B", movements(B.id) === mB0 && cross.json?.outcome !== "committed",
    ["rpc:public.op_execute"], `status ${cross.status} ${cross.json?.outcome ?? ""}`);

  // 6. B fences A's never-delivered key WITH A's arguments as evidence: refused
  const kU = v7();
  const fenceEv = await rpc(w.adminB2, "op_status", { p_key: kU, p_rpc: "adjust_stock", p_fence: true, p_expected_actor_id: null, p_args: adjustA });
  check("ops", "op_status fence: B ADMIN cannot fence a key whose arguments name A's rows", fenceEv.json?.fenced !== true && ledger(kU) === "<none>",
    ["rpc:public.op_status"], `${fenceEv.json?.status ?? fenceEv.status} reason ${fenceEv.json?.reason ?? "-"} ledger ${ledger(kU)}`);
  // ... and A's own ADMIN can stop it (then it never runs)
  const fenceA = await rpc(w.adminA2, "op_status", { p_key: kU, p_rpc: "adjust_stock", p_fence: true, p_expected_actor_id: A.people.admin.userId, p_args: adjustA });
  const late = await rpc(w.adminA2, "op_execute", { p_key: kU, p_rpc: "adjust_stock", p_args: adjustA, p_actor_id: A.people.admin.userId });
  check("ops", "op_status fence: A ADMIN stops A's undelivered key; a late copy never runs", fenceA.json?.fenced === true && late.json?.outcome === "abandoned" && ledger(kU).startsWith("abandoned/"),
    ["rpc:public.op_status"], `fence ${fenceA.json?.status} late ${late.json?.outcome}`);

  // 7. RESIDUAL (R3 / proposal §1): an own-actor fence whose arguments carry
  // no evidence of A — none, empty, or B's OWN rows — lets B claim a key A
  // minted but never delivered (the key is not bound to an organisation).
  const squatVariants: [string, Record<string, unknown> | null][] = [["no arguments", null], ["empty arguments", {}], ["B's own rows as arguments", adjustB]];
  for (const [label, args] of squatVariants) {
    const kS = v7();
    const mA2 = movements(A.id);
    const squat = await rpc(w.adminB2, "op_status", { p_key: kS, p_rpc: "adjust_stock", p_fence: true, p_expected_actor_id: B.people.admin.userId, p_args: args });
    const squatted = squat.json?.fenced === true;
    const aAfter = await rpc(w.adminA2, "op_execute", { p_key: kS, p_rpc: "adjust_stock", p_args: adjustA, p_actor_id: A.people.admin.userId });
    gap("ops", `op_status fence (${label}) cannot claim another organisation's never-delivered key`, !squatted, ["rpc:public.op_status"], "medium",
      `squat fenced=${squat.json?.fenced} ledger ${ledger(kS)}; A's own execution afterwards: ${aAfter.json?.outcome ?? aAfter.status} (denial of service only; no money moves)`);
    // whatever happened to the key: nothing in B, and A's effect is exactly what A's own outcome says
    const aRan = aAfter.json?.outcome === "committed";
    check("ops", `squat attempt (${label}): no effect in B; A's stock moved exactly ${"once if A's own execution committed, else not at all"}`,
      movements(B.id) === mB0 && movements(A.id) === mA2 + (aRan ? 1 : 0), ["rpc:public.op_status", "rpc:public.op_execute"],
      `A outcome ${aAfter.json?.outcome ?? aAfter.status}; B movements ${movements(B.id) - mB0}`);
  }

  // 8. same organisation, another actor: state only, reply withheld
  const peer = await rpc(A.people.cash.token, "op_status", { p_key: kA, p_rpc: "adjust_stock", p_fence: false, p_expected_actor_id: null, p_args: null });
  check("ops", "op_status: another user of the same organisation sees the state, never the reply (withheld)", peer.json?.status === "committed" && peer.json?.withheld === true && peer.json?.response == null,
    ["rpc:public.op_status"], `${peer.json?.status} withheld ${peer.json?.withheld}`);
  // ... and cannot fence a key in another user's name (not an administrator)
  const kP = v7();
  const peerFence = await rpc(A.people.cash.token, "op_status", { p_key: kP, p_rpc: "adjust_stock", p_fence: true, p_expected_actor_id: A.people.admin.userId, p_args: adjustA });
  check("ops", "op_status fence: a cashier cannot fence a key in the ADMIN's name", peerFence.json?.fenced !== true && ledger(kP) === "<none>", ["rpc:public.op_status"],
    `${peerFence.json?.status} ${peerFence.json?.reason ?? ""}`);
  // ... nor replay the ADMIN's committed key through the executor (reply withheld, nothing runs)
  const mA3 = movements(A.id);
  const peerReplay = await rpc(A.people.cash.token, "op_execute", { p_key: kA, p_rpc: "adjust_stock", p_args: adjustA, p_actor_id: A.people.cash.userId });
  check("ops", "op_execute: a same-organisation cashier replaying the ADMIN's committed key gets no reply and runs nothing", peerReplay.json?.response == null && movements(A.id) === mA3,
    ["rpc:public.op_execute"], `status ${peerReplay.status} ${peerReplay.json?.outcome ?? peerReplay.json?.message ?? ""}`.slice(0, 160));
  // ... nor gain a role through the executor (a cashier cannot create a supplier)
  const supBefore = Number(sql(`SELECT count(*) FROM suppliers WHERE org_id = ${q(A.id)}`));
  const esc = await rpc(A.people.cash.token, "op_execute", { p_key: v7(), p_rpc: "create_supplier",
    p_args: { p_code: `ESC${Date.now()}`, p_name: "escalation", p_contact_person: null, p_phone: null, p_email: null, p_address: null, p_notes: null },
    p_actor_id: A.people.cash.userId });
  check("ops", "op_execute: a cashier cannot run an ADMIN/MANAGER-only RPC through the executor", esc.json?.outcome !== "committed" && Number(sql(`SELECT count(*) FROM suppliers WHERE org_id = ${q(A.id)}`)) === supBefore,
    ["rpc:public.op_execute"], `status ${esc.status} ${esc.json?.outcome ?? esc.json?.message ?? ""}`.slice(0, 160));

  // 9. no anonymous access
  const anonExec = await rpc(null, "op_execute", { p_key: v7(), p_rpc: "adjust_stock", p_args: adjustA, p_actor_id: null });
  const anonStatus = await rpc(null, "op_status", { p_key: kA, p_rpc: "adjust_stock", p_fence: false, p_expected_actor_id: null, p_args: null });
  check("ops", "anon cannot call op_execute or op_status", anonExec.status >= 300 && anonStatus.status >= 300, ["rpc:public.op_execute", "rpc:public.op_status"],
    `exec ${anonExec.status} status ${anonStatus.status}`);

  // 10. the executor's helpers are not API-callable
  const exposed = sqlJson<string[]>(`SELECT coalesce(json_agg(p.proname ORDER BY p.proname), '[]') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'op\\_%' AND p.proname NOT IN ('op_execute', 'op_status')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`);
  check("ops", "no other op_* function is executable by anon or authenticated", exposed.length === 0, ["rpc:public.op_execute"], exposed.join(","));
}
