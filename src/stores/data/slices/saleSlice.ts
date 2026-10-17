import type { StateCreator } from "zustand";
import type { DataState, SaleState, CreateSaleInput } from "../types";
import type { AuditLog, Inventory, InventoryMovement, Refund, Sale, SaleItem } from "../../../types";
import { isNetworkError } from "../../../lib/errors";
import { newId } from "../../../lib/id";
import { calculateCartTotals } from "../../../features/pos/service";
import { enqueueOutbox, recordIdMapping } from "../outbox";
import {
  beginOperation, callRpc, newIdempotencyKey, ONLINE_ONLY_RETRIES, type OperationContext,
} from "../idempotentRpc";
import { deleteLocalRows, putLocalRows } from "../localWrites";
import { assertOfflineWriteEligible } from "../../authStore";

// Shape returned by the complete_sale RPC (keys are already camelCase).
interface CompleteSaleResult {
  sale: Sale;
  items: SaleItem[];
  movements: InventoryMovement[];
  inventory: Inventory[];
  auditLogs: AuditLog[];
  shopName: string;
  cashierName: string;
}

interface ApprovalResult {
  request: Refund;
  sale: Sale;
  movements: InventoryMovement[];
  inventory: Inventory[];
  auditLogs: AuditLog[];
}

interface RequestResult {
  request: Refund;
  auditLogs: AuditLog[];
}

// Merge RPC-returned inventory rows into the current store array.
const mergeInventory = (current: Inventory[], updates: Inventory[]): Inventory[] => {
  const result = [...current];
  for (const u of updates) {
    const idx = result.findIndex((i) => i.shopId === u.shopId && i.productId === u.productId);
    if (idx >= 0) result[idx] = { ...result[idx], qtyBaseUnits: u.qtyBaseUnits };
    else result.push(u);
  }
  return result;
};

const mergeRefundRequest = (current: Refund[], request: Refund): Refund[] => {
  const exists = current.some((item) => item.id === request.id);
  if (!exists) return [request, ...current];
  return current.map((item) => (item.id === request.id ? request : item));
};

// Builds the complete_sale RPC payload from the cart. Shared by the online
// call and the offline path (which stores the same payload in the outbox to
// replay verbatim once back online) so the two can never drift apart — the
// same event time AND the same idempotency key on every attempt.
const buildCompleteSaleArgs = (
  { shopId, shiftId, cartItems, cartDiscountPct, paymentMethod, paidMmk }: CreateSaleInput,
  get: () => DataState,
  { createdAt, idempotencyKey }: OperationContext,
) => {
  const items = cartItems.map((item) => {
    const baseQuantitySold = item.qty * item.unitBaseQuantity;
    const productUnit = get().productUnits.find((unit) => unit.id === item.productUnitId);
    const unitPrice = item.priceOverriddenBy
      ? item.unitPriceMmk
      : productUnit?.isDefault && item.unitBaseQuantity === 1
        ? get().getProductPrice(item.productId, shopId, baseQuantitySold) || item.unitPriceMmk
        : item.unitPriceMmk;
    // Open Price items always submit their cashier-entered unit price
    // — the server requires a price for is_open_price=true products
    // because there's no fixed/level price to fall back to.
    const sendUnitPrice = item.isOpenPrice
      ? item.unitPriceMmk
      : item.priceOverriddenBy
        ? unitPrice
        : null;
    return {
      product_id: item.productId,
      product_unit_id: item.productUnitId,
      // Forward the cashier's chosen price level — the RPC resolves
      // the final price server-side via product_unit_prices with the
      // shop_override → global → retail_fallback → legacy chain.
      // For Open Price items the level is captured for the receipt
      // label only; the server takes the client price as authoritative.
      price_level_id: item.priceLevelId ?? null,
      qty: item.qty,
      units_per_item: item.unitBaseQuantity,
      unit_price_mmk: sendUnitPrice,
      item_discount_pct: item.itemDiscountPct ?? 0,
      unit_label: item.unitName,
      price_overridden: Boolean(item.priceOverriddenBy),
      stock_override_requested: Boolean(item.stockOverrideBy),
    };
  });

  return {
    p_shop_id: shopId,
    p_shift_id: shiftId,
    p_payment_method: paymentMethod,
    p_paid_mmk: paidMmk,
    p_cart_discount_pct: cartDiscountPct,
    p_items: items,
    // The moment this sale actually happened — preserved through an
    // offline queue-and-replay so a sale rung up at 3pm that doesn't sync
    // until 9pm still records/reports as a 3pm sale. See migration 045.
    p_created_at: createdAt,
    // Minted when the sale was created; a retry after a lost response
    // returns the original result instead of a second sale (Phase D).
    p_idempotency_key: idempotencyKey,
  };
};

export const createSaleSlice: StateCreator<DataState, [], [], SaleState> = (set, get) => {
  // POS checkout: a single atomic Supabase RPC. The database validates
  // permission, shop scope, the open shift, stock and overrides, then writes
  // the sale, items, inventory, movements and audit rows in one transaction.
  const createSaleOnline = async (input: CreateSaleInput, op: OperationContext): Promise<string> => {
    const { data, error } = await callRpc("complete_sale", buildCompleteSaleArgs(input, get, op));
    if (error) throw error;
    if (!data) throw new Error("Checkout returned no data.");

    const result = data as CompleteSaleResult;

    // Reconcile local state from the authoritative RPC result.
    set((state) => ({
      sales: [result.sale, ...state.sales],
      saleItems: [...result.items, ...state.saleItems],
      inventory: mergeInventory(state.inventory, result.inventory),
      movements: [...result.movements, ...state.movements],
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
    void putLocalRows({
      sales: [result.sale], saleItems: result.items,
      inventory: result.inventory, movements: result.movements, auditLogs: result.auditLogs,
    });

    return result.sale.id;
  };

  // No network (or the network call above just failed): stage the sale
  // locally — using the same client-side stock/price math the cart already
  // shows the cashier — so checkout keeps working, and queue the exact RPC
  // call for replay once back online. The server is still the final say:
  // reconcileCompleteSale() below replaces this provisional record with
  // whatever the server actually accepts.
  const createSaleOffline = async (input: CreateSaleInput, op: OperationContext): Promise<string> => {
    await assertOfflineWriteEligible();
    const { shopId, shiftId, cashierId, cartItems, cartDiscountPct, paymentMethod, paidMmk } = input;
    const now = op.createdAt;
    const saleId = newId("sale");

    const items: SaleItem[] = [];
    const movements: InventoryMovement[] = [];
    // Running per-product tally so multiple cart lines for the same product
    // deduct cumulatively, mirroring complete_sale's own running ledger.
    const runningQty = new Map<string, number>();
    const qtyFor = (productId: string) =>
      runningQty.get(productId) ?? get().getInventoryQty(shopId, productId);

    for (const item of cartItems) {
      const baseQuantitySold = item.qty * item.unitBaseQuantity;
      const product = get().products.find((p) => p.id === item.productId);
      const qtyBefore = qtyFor(item.productId);
      if (!product?.isNonStock && !item.stockOverrideBy && qtyBefore < baseQuantitySold) {
        throw new Error(`Only ${qtyBefore} in stock for this shop.`);
      }
      const qtyAfter = qtyBefore - baseQuantitySold;
      runningQty.set(item.productId, qtyAfter);

      const lineTotalMmk = Math.round(
        item.qty * item.unitPriceMmk * (1 - (item.itemDiscountPct ?? 0) / 100),
      );
      items.push({
        id: newId("si"),
        saleId,
        productId: item.productId,
        qtyUnits: item.qty,
        unitPriceMmk: item.unitPriceMmk,
        itemDiscountPct: item.itemDiscountPct,
        lineTotalMmk,
        priceOverriddenBy: item.priceOverriddenBy,
        unitLabel: item.unitName,
        unitsPerItem: item.unitBaseQuantity,
        productUnitId: item.productUnitId,
        baseQuantitySold,
      });

      if (!product?.isNonStock) {
        movements.push({
          id: newId("move"),
          shopId, productId: item.productId, type: "SALE_OUT",
          qtyChange: -baseQuantitySold, qtyBefore, qtyAfter,
          reason: "POS sale (offline — pending sync)",
          referenceType: "sale", referenceId: saleId,
          createdBy: cashierId, createdAt: now,
          productUnitId: item.productUnitId,
          pendingSync: true,
        });
      }
    }

    const inventoryUpdates: Inventory[] = Array.from(runningQty, ([productId, qtyBaseUnits]) => ({
      shopId, productId, qtyBaseUnits,
    }));

    const { subtotal, itemDiscount, cartDiscount, total } = calculateCartTotals(cartItems, cartDiscountPct);
    const sale: Sale = {
      id: saleId, shopId, shiftId,
      // The real receipt number is sequenced server-side; this placeholder
      // is swapped for the authoritative one once complete_sale actually runs.
      receiptNo: "PENDING",
      cashierId, status: "NORMAL",
      subtotalMmk: subtotal, discountMmk: itemDiscount + cartDiscount, cartDiscountPct,
      totalMmk: total, paymentMethod, paidMmk, changeMmk: Math.max(0, paidMmk - total),
      createdAt: now, pendingSync: true, idempotencyKey: op.idempotencyKey,
    };

    set((state) => ({
      sales: [sale, ...state.sales],
      saleItems: [...items, ...state.saleItems],
      inventory: mergeInventory(state.inventory, inventoryUpdates),
      movements: [...movements, ...state.movements],
    }));
    void putLocalRows({ sales: [sale], saleItems: items, inventory: inventoryUpdates, movements });

    // If the shift itself was also opened offline and hasn't synced yet,
    // this sale has to wait for that RPC's real shift id — see resolveArgs()
    // in outbox.ts.
    const shiftIsProvisional = get().shifts.find((s) => s.id === shiftId)?.pendingSync === true;

    await enqueueOutbox({
      kind: "rpc",
      name: "complete_sale",
      args: buildCompleteSaleArgs(input, get, op),
      idempotencyKey: op.idempotencyKey,
      shopId,
      refs: shiftIsProvisional ? [{ field: "p_shift_id", provisionalId: shiftId }] : undefined,
      provisional: [
        { table: "sales", ids: [saleId] },
        { table: "saleItems", ids: items.map((i) => i.id!) },
        { table: "movements", ids: movements.map((m) => m.id) },
      ],
    });

    return saleId;
  };

  const createRefundVoidRequestOnline = async (
    saleId: string, type: "VOID" | "PARTIAL", reason: string,
    items: { productId: string; qtyUnits: number; amountMmk: number }[] | null,
    op: OperationContext,
  ): Promise<void> => {
    const { data, error } = await callRpc("create_refund_void_request", {
      p_sale_id: saleId, p_type: type, p_reason: reason, p_items: items,
      p_created_at: op.createdAt, p_idempotency_key: op.idempotencyKey,
    });
    if (error) throw error;
    if (!data) throw new Error("Request returned no data.");
    const result = data as RequestResult;

    set((state) => ({
      refunds: mergeRefundRequest(state.refunds, result.request),
      refundVoidRequests: mergeRefundRequest(state.refundVoidRequests, result.request),
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
    void putLocalRows({ refunds: [result.request], auditLogs: result.auditLogs });
  };

  // No network: stage the request locally (status REQUESTED, same as the
  // server mints it) and queue create_refund_void_request for replay. If
  // the sale itself is still provisional (rung up offline in this same
  // session), carry a ref so this waits for the sale's real id — see
  // reconcileCompleteSale's recordIdMapping call.
  const createRefundVoidRequestOffline = async (
    saleId: string, type: "VOID" | "PARTIAL", reason: string,
    items: { productId: string; qtyUnits: number; amountMmk: number }[] | undefined, actorId: string,
    op: OperationContext,
  ): Promise<void> => {
    await assertOfflineWriteEligible();
    const sale = get().sales.find((s) => s.id === saleId);
    if (!sale) throw new Error("Sale not found.");

    const now = op.createdAt;
    const request: Refund = {
      id: newId("refund"), saleId, shopId: sale.shopId, type, reason,
      createdBy: actorId, createdAt: now,
      items, status: "REQUESTED", pendingSync: true, idempotencyKey: op.idempotencyKey,
    };
    set((state) => ({
      refunds: mergeRefundRequest(state.refunds, request),
      refundVoidRequests: mergeRefundRequest(state.refundVoidRequests, request),
    }));
    void putLocalRows({ refunds: [request] });

    await enqueueOutbox({
      kind: "rpc",
      name: "create_refund_void_request",
      args: {
        p_sale_id: saleId, p_type: type, p_reason: reason, p_items: items ?? null,
        p_created_at: now, p_idempotency_key: op.idempotencyKey,
      },
      idempotencyKey: op.idempotencyKey,
      shopId: sale.shopId,
      refs: sale.pendingSync ? [{ field: "p_sale_id", provisionalId: saleId }] : undefined,
      provisional: [{ table: "refunds", ids: [request.id] }],
    });
  };

  return {
  sales: [],
  saleItems: [],
  refunds: [],
  refundVoidRequests: [],

  createSale: async (input: CreateSaleInput) => {
    // One key + one event time per checkout, minted before the first
    // attempt: if the online call fails on the network after the server
    // committed, the queued replay carries the same key and gets the
    // original sale back instead of ringing it up twice.
    const op = beginOperation();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return createSaleOffline(input, op);
    }
    try {
      return await createSaleOnline(input, op);
    } catch (err) {
      if (isNetworkError(err)) return createSaleOffline(input, op);
      throw err;
    }
  },

  // Called by the outbox once a queued complete_sale actually runs — swaps
  // the provisional sale/items/movements for the server's authoritative rows.
  reconcileCompleteSale: (data, provisional) => {
    const result = data as CompleteSaleResult;
    const provisionalSaleIds = new Set(provisional.find((p) => p.table === "sales")?.ids ?? []);
    const provisionalItemIds = new Set(provisional.find((p) => p.table === "saleItems")?.ids ?? []);
    const provisionalMovementIds = new Set(provisional.find((p) => p.table === "movements")?.ids ?? []);

    // The server's rows may already be in the store: a full reload that
    // ran between the (lost-response) commit and this replay returns them
    // alongside the still-queued provisional ones. Drop both the
    // provisional ids and any existing copy of the authoritative ids, so a
    // sale is never listed twice (it would inflate the shift's expected
    // cash — Phase E finding).
    const resultItemIds = new Set(result.items.map((i) => i.id));
    const resultMovementIds = new Set(result.movements.map((m) => m.id));
    const resultAuditIds = new Set(result.auditLogs.map((a) => a.id));
    set((state) => ({
      sales: [result.sale, ...state.sales.filter((s) => !provisionalSaleIds.has(s.id) && s.id !== result.sale.id)],
      saleItems: [...result.items, ...state.saleItems.filter((i) => !i.id || (!provisionalItemIds.has(i.id) && !resultItemIds.has(i.id)))],
      inventory: mergeInventory(state.inventory, result.inventory),
      movements: [...result.movements, ...state.movements.filter((m) => !provisionalMovementIds.has(m.id) && !resultMovementIds.has(m.id))],
      auditLogs: [...result.auditLogs, ...state.auditLogs.filter((a) => !resultAuditIds.has(a.id))],
    }));
    void deleteLocalRows(provisional);
    void putLocalRows({
      sales: [result.sale], saleItems: result.items,
      inventory: result.inventory, movements: result.movements, auditLogs: result.auditLogs,
    });
    // A void/refund request raised offline against this same sale (before it
    // had synced) will be queued with a ref to its provisional id — resolve
    // it now that the real one exists.
    const provisionalSaleId = [...provisionalSaleIds][0];
    if (provisionalSaleId) void recordIdMapping(provisionalSaleId, result.sale.id);
  },

  voidSale: async ({ saleId, reason }) => {
    const { data, error } = await callRpc("create_refund_void_request", {
      p_sale_id: saleId,
      p_type: "VOID",
      p_reason: reason,
      p_items: null,
      p_idempotency_key: newIdempotencyKey(),
    }, { retries: ONLINE_ONLY_RETRIES });
    if (error) throw error;
    if (!data) throw new Error("Void request returned no data.");
    const result = data as RequestResult;

    set((state) => ({
      refunds: mergeRefundRequest(state.refunds, result.request),
      refundVoidRequests: mergeRefundRequest(state.refundVoidRequests, result.request),
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
  },

  requestVoid: async ({ saleId, reason, actorId }) => {
    const op = beginOperation();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return createRefundVoidRequestOffline(saleId, "VOID", reason, undefined, actorId, op);
    }
    try {
      await createRefundVoidRequestOnline(saleId, "VOID", reason, null, op);
    } catch (err) {
      if (isNetworkError(err)) return createRefundVoidRequestOffline(saleId, "VOID", reason, undefined, actorId, op);
      throw err;
    }
  },

  requestRefund: async ({ saleId, items, reason, actorId }) => {
    const payload = items.map((item) => ({
      productId: item.productId, qtyUnits: item.qtyUnits, amountMmk: item.amountMmk,
    }));
    const op = beginOperation();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return createRefundVoidRequestOffline(saleId, "PARTIAL", reason, payload, actorId, op);
    }
    try {
      await createRefundVoidRequestOnline(saleId, "PARTIAL", reason, payload, op);
    } catch (err) {
      if (isNetworkError(err)) return createRefundVoidRequestOffline(saleId, "PARTIAL", reason, payload, actorId, op);
      throw err;
    }
  },

  // Called by the outbox once a queued create_refund_void_request actually
  // runs — covers both requestVoid and requestRefund, which share the RPC.
  reconcileCreateRefundVoidRequest: (data, provisional) => {
    const result = data as RequestResult;
    const provisionalIds = new Set(provisional.find((p) => p.table === "refunds")?.ids ?? []);

    set((state) => ({
      refunds: mergeRefundRequest(state.refunds.filter((r) => !provisionalIds.has(r.id)), result.request),
      refundVoidRequests: mergeRefundRequest(
        state.refundVoidRequests.filter((r) => !provisionalIds.has(r.id)), result.request,
      ),
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
    void deleteLocalRows(provisional);
    void putLocalRows({ refunds: [result.request], auditLogs: result.auditLogs });
    const provisionalId = [...provisionalIds][0];
    if (provisionalId) void recordIdMapping(provisionalId, result.request.id);
  },

  approveRefund: async ({ refundId }) => {
    const request = get().refundVoidRequests.find((item) => item.id === refundId) ?? get().refunds.find((item) => item.id === refundId);
    if (!request) throw new Error("Refund or void request not found.");

    const rpcName = request.type === "VOID" ? "approve_void_request" : "approve_refund_request";
    const { data, error } = await callRpc(
      rpcName, { p_request_id: refundId, p_idempotency_key: newIdempotencyKey() }, { retries: ONLINE_ONLY_RETRIES },
    );
    if (error) throw error;
    if (!data) throw new Error("Approval returned no data.");

    const result = data as ApprovalResult;

    set((state) => ({
      refunds: mergeRefundRequest(state.refunds, result.request),
      refundVoidRequests: mergeRefundRequest(state.refundVoidRequests, result.request),
      sales: state.sales.map((sale) => (sale.id === result.sale.id ? result.sale : sale)),
      inventory: mergeInventory(state.inventory, result.inventory),
      movements: [...result.movements, ...state.movements],
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
  },

  // Online only (a decision, like approval — never queued). The server
  // checks the request is still pending and the approver may decide it.
  rejectRefund: async ({ refundId, reason }) => {
    const { data, error } = await callRpc(
      "reject_refund_void_request",
      { p_request_id: refundId, p_reason: reason, p_idempotency_key: newIdempotencyKey() },
      { retries: ONLINE_ONLY_RETRIES },
    );
    if (error) throw error;
    if (!data) throw new Error("Rejection returned no data.");
    const result = data as RequestResult;
    set((state) => ({
      refunds: mergeRefundRequest(state.refunds, result.request),
      refundVoidRequests: mergeRefundRequest(state.refundVoidRequests, result.request),
      auditLogs: [...(result.auditLogs ?? []), ...state.auditLogs],
    }));
    void putLocalRows({ refunds: [result.request], auditLogs: result.auditLogs ?? [] });
  },
  };
};
