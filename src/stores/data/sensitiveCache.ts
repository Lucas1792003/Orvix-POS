// ----------------------------------------------------------------------
// Sensitive data on a shared device (financial-safety fix 3; extends P-4).
//
// What a signed-in person may see of purchasing and supplier money is decided
// by the server's row security (069): purchase orders / their items for
// ADMIN (any shop of the organisation) or purchase:view (own shop); supplier
// payments for ADMIN or own shop with supplier:debt_view or purchase:view;
// audit messages for ADMIN / audit:view_global (organisation) or
// audit:view_shop (own shop). Purchase cost / COGS: report:shop_profit
// (costPrivacy.ts).
//
// The device mirror (IndexedDB) outlives a session. So:
//   - on LOGOUT, purchase orders, supplier payments and audit messages are
//     dropped from memory, and on disk the money fields of every row the
//     server sent (and every audit message) are removed. Rows themselves stay
//     (their ids are what the vanished-row continuity check compares), and
//     rows still waiting to be sent (pendingSync) are untouched, as are the
//     outbox, the operation journal and every other table;
//   - on START-UP (account switch, offline restart), the mirror is shown only
//     as far as the signed-in person may see it, and whatever they may not
//     see is scrubbed on disk the same way.
// Nothing here deletes a financial operation or touches signed evidence.
// ----------------------------------------------------------------------
import { localDb } from "../../lib/localDb";
import { hasPermission } from "../../lib/permissions";
import type { AuditLog, PurchaseOrder, PurchaseOrderItem, SupplierPayment, User } from "../../types";
import { applyCostOverlay, scrubLocalCostCache, userMayViewCost } from "./costPrivacy";
import type { LocalSnapshot } from "./localSync";

/** null = may see nothing of it. "org" = every shop of the organisation. */
type ShopScope = "org" | { shopId: string } | null;

export interface Viewer {
  cost: boolean;
  purchases: ShopScope;
  supplierPayments: ShopScope;
  audit: ShopScope;
}

/** Nobody signed in (logout): nothing sensitive. */
export const NO_VIEWER: Viewer = { cost: false, purchases: null, supplierPayments: null, audit: null };

const ownShop = (me: User | undefined): ShopScope => (me?.shopId ? { shopId: me.shopId } : null);

/** The same decisions as the server's row security (069), for the cached rows. */
export function viewerFor(users: readonly User[], userId: string | null | undefined): Viewer {
  const me = userId ? users.find((u) => u.id === userId) : undefined;
  if (!me || me.isActive === false) return NO_VIEWER;
  const admin = me.role === "ADMIN";
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(me, p);
  return {
    cost: userMayViewCost(users, userId),
    purchases: admin ? "org" : can("purchase:view") ? ownShop(me) : null,
    supplierPayments: admin ? "org" : can("supplier:debt_view") || can("purchase:view") ? ownShop(me) : null,
    audit: admin || can("audit:view_global") ? "org" : can("audit:view_shop") ? ownShop(me) : null,
  };
}

const inScope = (scope: ShopScope, shopId: string | null | undefined): boolean =>
  scope === "org" || (scope !== null && !!shopId && scope.shopId === shopId);

const sameViewer = (a: Viewer, b: Viewer): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The cached snapshot as far as this person may see it (memory only). */
export function limitSnapshotToViewer<S extends LocalSnapshot>(snapshot: S, viewer: Viewer): S {
  const purchaseOrders = snapshot.purchaseOrders.filter((po) => inScope(viewer.purchases, po.shopId));
  const visiblePo = new Set(purchaseOrders.map((po) => po.id));
  // cost: kept as cached for a permitted person, removed for anyone else
  const base = viewer.cost ? snapshot : applyCostOverlay(snapshot, null, false);
  return {
    ...base,
    purchaseOrders,
    purchaseOrderItems: snapshot.purchaseOrderItems.filter((i) => visiblePo.has(i.purchaseOrderId)),
    supplierPayments: snapshot.supplierPayments.filter((p) => inScope(viewer.supplierPayments, p.shopId)),
    auditLogs: snapshot.auditLogs.filter((a) => inScope(viewer.audit, a.shopId ?? null)),
  };
}

// ---------------------------------------------------------------- the mirror
const PO_MONEY = ["subtotalMmk", "taxMmk", "totalMmk", "paidMmk"] as const;
const PO_ITEM_MONEY = ["unitCostMmk", "lineTotalMmk", "unitPurchasePriceSnapshot"] as const;

/**
 * Remove, on disk, every sensitive field `viewer` may not see. Rows are kept;
 * rows still waiting to be sent (pendingSync) are never touched — their
 * values are the operation itself, already in the outbox. Audit messages are
 * cleared (the row stays). Idempotent.
 */
export async function scrubLocalSensitiveCache(viewer: Viewer): Promise<void> {
  if (!viewer.cost) await scrubLocalCostCache();
  await localDb.transaction("rw", [localDb.purchaseOrders, localDb.purchaseOrderItems, localDb.supplierPayments, localDb.auditLogs], async () => {
    const hiddenPo = new Set<string>();
    await localDb.purchaseOrders.toCollection().modify((row: Partial<PurchaseOrder>) => {
      if (inScope(viewer.purchases, row.shopId)) return;
      if (row.id) hiddenPo.add(row.id);
      if (row.pendingSync) return;
      for (const k of PO_MONEY) delete row[k];
    });
    const pendingPo = new Set((await localDb.purchaseOrders.toArray()).filter((po) => po.pendingSync).map((po) => po.id));
    await localDb.purchaseOrderItems.toCollection().modify((row: Partial<PurchaseOrderItem>) => {
      if (!row.purchaseOrderId || !hiddenPo.has(row.purchaseOrderId) || pendingPo.has(row.purchaseOrderId)) return;
      for (const k of PO_ITEM_MONEY) delete row[k];
    });
    await localDb.supplierPayments.toCollection().modify((row: Partial<SupplierPayment>) => {
      if (inScope(viewer.supplierPayments, row.shopId) || row.pendingSync) return;
      delete row.amountMmk;
    });
    await localDb.auditLogs.toCollection().modify((row: Partial<AuditLog>) => {
      if (inScope(viewer.audit, row.shopId ?? null)) return;
      row.message = "";
    });
  });
}

/** Start-up: the cached snapshot for this person, and the mirror scrubbed of what they may not see. */
export async function prepareCachedSnapshot<S extends LocalSnapshot>(
  raw: S, userId: string | null | undefined,
): Promise<S> {
  const viewer = viewerFor(raw.users, userId);
  const limited = limitSnapshotToViewer(raw, viewer);
  const full: Viewer = { cost: true, purchases: "org", supplierPayments: "org", audit: "org" };
  if (!sameViewer(viewer, full)) {
    await scrubLocalSensitiveCache(viewer).catch((err) => console.error("[DB] sensitive cache scrub failed:", err));
  }
  return limited;
}
