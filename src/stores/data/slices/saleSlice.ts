import type { StateCreator } from "zustand";
import type { DataState, SaleState, CreateSaleInput, RefundItemInput } from "../types";
import type { AuditLog, Inventory, InventoryMovement, Refund, Sale, SaleItem } from "../../../types";
import { newId } from "../../../lib/id";
import { calculateCartTotals } from "../../../features/pos/service";
import { planPayments } from "../../../features/finance/finCompletion";
import { recordIdMapping } from "../outbox";
import { beginOperation, newIdempotencyKey, ONLINE_ONLY_RETRIES, type OperationContext } from "../idempotentRpc";
import { callOnlineOnly } from "../onlineOnly";
import { deleteLocalRows, putLocalRows } from "../localWrites";
import { Stage, submitOfflineCapable } from "../writeAhead";
import { rememberSaleOperation } from "../opJournal";
import { assertStockKnown, serverStockRows } from "../stockLedger";
import { assertOfflineWriteEligible, useAuthStore } from "../../authStore";
import { stripLineCost, userMayViewCost } from "../costPrivacy";
import { cartDiscountPolicy, tierReferencePrice } from "../../../features/pos/discountPolicy";
import { hasPermission } from "../../../lib/permissions";

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

/** Step 6 (PDISC-A): a discount that needs an approval (or a sale naming one) is never recorded offline. */
export const DISCOUNT_APPROVAL_OFFLINE_MESSAGE = "This discount needs approval and cannot be recorded offline; nothing was saved.";
/** Step 6 (PDISC-A): such a sale is sent at once or not at all — never parked behind earlier queued entries. */
export const DISCOUNT_APPROVAL_BACKLOG_MESSAGE =
  "This sale has a discount that needs approval, and earlier entries on this till have not reached the server yet. Nothing was saved. "
  + "Sync first, then ring it up again (an approval is used once and expires 30 minutes after it was given — ask again if it has expired).";

/** Step 6 (PFIN-F): shown when a refund is attempted while this till is offline. */
export const REFUND_OFFLINE_MESSAGE = "Refunds are recorded online only. Connect this till to the server and try again. Nothing was saved.";

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
  { shopId, shiftId, cartItems, cartDiscountPct, paymentMethod, paidMmk, payments }: CreateSaleInput,
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
    // Step 4 (PFIN-D): the split travels beside the sale (idempotentRpc sends it through
    // fin_complete_sale_split, never inside complete_sale's own hashed arguments).
    ...(payments && payments.length > 0 ? { p_payments: payments } : {}),
  };
};

export const createSaleSlice: StateCreator<DataState, [], [], SaleState> = (set, get) => {
  const isProvisionalShift = (shiftId: string): boolean =>
    (get().shifts ?? []).find((s) => s.id === shiftId)?.pendingSync === true;

  // POS checkout: a single atomic Supabase RPC. The database validates
  // permission, shop scope, the open shift, stock and overrides, then writes
  // the sale, items, inventory, movements and audit rows in one transaction.
  // Apply complete_sale's (validated) reply to the store and the mirror.
  // P-4: an older server returns the line cost snapshot to the cashier; never
  // keep it (memory or mirror) for a user without report:shop_profit.
  const withoutHiddenCost = (result: CompleteSaleResult): CompleteSaleResult =>
    userMayViewCost(get().users ?? [], useAuthStore.getState().currentUserId)
      ? result
      : { ...result, items: result.items.map(stripLineCost) };

  const applyCompleteSale = async (data: unknown, ackId: string, payments?: CreateSaleInput["payments"]): Promise<string> => {
    const confirmed = withoutHiddenCost(data as CompleteSaleResult);
    // the server confirmed THIS split (fin_complete_sale_split checks it); its reply carries no payment lines
    const result = payments && payments.length > 0 ? { ...confirmed, sale: { ...confirmed.sale, payments } } : confirmed;
    // Server rows + the effects of other unresolved entries (stockLedger.ts).
    const shownStock = serverStockRows(result.inventory, ackId);

    // Reconcile local state from the authoritative RPC result.
    set((state) => ({
      sales: [result.sale, ...state.sales],
      saleItems: [...result.items, ...state.saleItems],
      inventory: mergeInventory(state.inventory, shownStock),
      movements: [...result.movements, ...state.movements],
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
    await putLocalRows({
      sales: [result.sale], saleItems: result.items,
      movements: result.movements, auditLogs: result.auditLogs,
    });

    return result.sale.id;
  };

  // No network (or the network call above just failed): stage the sale
  // locally — using the same client-side stock/price math the cart already
  // shows the cashier — so checkout keeps working, and queue the exact RPC
  // call for replay once back online. The server is still the final say:
  // reconcileCompleteSale() below replaces this provisional record with
  // whatever the server actually accepts.
  const stageSale = async (input: CreateSaleInput, op: OperationContext, stage: Stage): Promise<string> => {
    // The offline rules apply in both modes: an unknown outcome never
    // authorises a sale this till could not make offline (correction pass).
    await assertOfflineWriteEligible();
    assertStockKnown();
    const { shopId, shiftId, cashierId, cartItems, cartDiscountPct, paymentMethod, paidMmk, payments } = input;
    const now = op.createdAt;
    const saleId = newId("sale");

    const items: SaleItem[] = [];
    const movements: InventoryMovement[] = [];
    // Running per-product tally so multiple cart lines for the same product
    // deduct cumulatively, mirroring complete_sale's own running ledger.
    const runningQty = new Map<string, number>();
    const qtyFor = (productId: string) =>
      runningQty.get(productId) ?? stage.qty(get, shopId, productId);

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
      ...(payments && payments.length > 0 ? { payments } : {}),
      createdAt: now, pendingSync: true, idempotencyKey: op.idempotencyKey,
      // Outcome unknown: shown as unconfirmed, never as a recorded sale.
      ...(stage.mode === "in-doubt" ? { pendingConfirmation: true } : {}),
    };

    stage.set((state: DataState) => ({
      sales: [sale, ...state.sales],
      saleItems: [...items, ...state.saleItems],
      inventory: mergeInventory(state.inventory, inventoryUpdates),
      movements: [...movements, ...state.movements],
    }));
    stage.put({ sales: [sale], saleItems: items, inventory: inventoryUpdates, movements });

    // If the shift itself was also opened offline and hasn't synced yet,
    // this sale has to wait for that RPC's real shift id — see resolveArgs()
    // in outbox.ts.
    const shiftIsProvisional = isProvisionalShift(shiftId);

    stage.enqueue({
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

  // The ONE argument builder for create_refund_void_request (online and queued).
  const buildRequestArgs = (
    saleId: string, type: "VOID" | "PARTIAL", reason: string,
    items: RefundItemInput[] | null | undefined, op: OperationContext,
  ) => ({
    p_sale_id: saleId, p_type: type, p_reason: reason, p_items: items ?? null,
    p_created_at: op.createdAt, p_idempotency_key: op.idempotencyKey,
  });

  const applyRefundVoidRequest = async (data: unknown): Promise<void> => {
    const result = data as RequestResult;

    set((state) => ({
      refunds: mergeRefundRequest(state.refunds, result.request),
      refundVoidRequests: mergeRefundRequest(state.refundVoidRequests, result.request),
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
    await putLocalRows({ refunds: [result.request], auditLogs: result.auditLogs });
  };

  // No network: stage the request locally (status REQUESTED, same as the
  // server mints it) and queue create_refund_void_request for replay. If
  // the sale itself is still provisional (rung up offline in this same
  // session), carry a ref so this waits for the sale's real id — see
  // reconcileCompleteSale's recordIdMapping call.
  const stageRefundVoidRequest = async (
    saleId: string, type: "VOID" | "PARTIAL", reason: string,
    items: RefundItemInput[] | undefined, actorId: string,
    op: OperationContext, stage: Stage,
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
    stage.set((state: DataState) => ({
      refunds: mergeRefundRequest(state.refunds, request),
      refundVoidRequests: mergeRefundRequest(state.refundVoidRequests, request),
    }));
    stage.put({ refunds: [request] });

    stage.enqueue({
      kind: "rpc",
      name: "create_refund_void_request",
      args: buildRequestArgs(saleId, type, reason, items, op),
      idempotencyKey: op.idempotencyKey,
      shopId: sale.shopId,
      refs: sale.pendingSync ? [{ field: "p_sale_id", provisionalId: saleId }] : undefined,
      provisional: [{ table: "refunds", ids: [request.id] }],
    });
  };

  // Write-ahead lifecycle (writeAhead.ts), like checkout.
  const submitRequest = (
    saleId: string, type: "VOID" | "PARTIAL", reason: string,
    items: RefundItemInput[] | undefined, actorId: string,
  ): Promise<void> => {
    const op = beginOperation();
    const sale = get().sales.find((s) => s.id === saleId);
    return submitOfflineCapable({
      set, name: "create_refund_void_request", shopId: sale?.shopId ?? null, op,
      args: buildRequestArgs(saleId, type, reason, items, op),
      needsProvisionalRefs: sale?.pendingSync === true,
      applyOnline: applyRefundVoidRequest,
      stage: (stage) => stageRefundVoidRequest(saleId, type, reason, items, actorId, op, stage),
    });
  };

  return {
  sales: [],
  saleItems: [],
  refunds: [],
  refundVoidRequests: [],

  createSale: async (input: CreateSaleInput) => {
    // One key + one event time per checkout, minted before the first
    // attempt and written to the outbox BEFORE it is sent (write-ahead,
    // writeAhead.ts): a lost reply, a crash or a refused fallback can no
    // longer leave a committed sale without a durable record, and pressing
    // Confirm again while it is unresolved reuses it instead of a new key.
    // Step 6 (PDISC-A): the approval rides on the OPERATION (every attempt of this key carries it), not in its arguments
    const op: OperationContext = { ...beginOperation(), ...(input.discountApprovalId ? { discountApprovalId: input.discountApprovalId } : {}) };
    if (input.payments && input.payments.length > 0) {
      // the same rule the server applies (fin_complete_sale_split): refuse here, before anything is recorded
      const total = calculateCartTotals(input.cartItems, input.cartDiscountPct).total;
      const planned = planPayments(input.payments, total);
      if (!planned.ok) throw new Error(`Payment split is not valid (${planned.problem.code}).`);
      if (planned.plan.legacyMethod !== input.paymentMethod || planned.plan.paidMmk !== input.paidMmk) {
        throw new Error("Payment split is not valid (method or amount received differs from the split).");
      }
    }
    // Step 6 (PDISC-A): a sale naming an approval, or whose discount needs one (the seller's own limit, rule (a)), is
    // SENT NOW or not at all: never staged, queued or recorded offline (refused before anything is saved or sent —
    // whatever the server-capability probe said; online the server decides as before).
    const seller = (get().users ?? []).find((u) => u.id === input.cashierId) ?? null;
    const policy = cartDiscountPolicy(input.cartItems, input.cartDiscountPct, {
      role: seller?.role ?? useAuthStore.getState().currentRole ?? null,
      canApplyDiscount: seller ? hasPermission(seller, "pos:apply_discount") : false,
    }, tierReferencePrice({ shopId: input.shopId, productUnits: get().productUnits, priceLevels: get().priceLevels, priceTiers: get().priceTiers }));
    const approvalBound = Boolean(input.discountApprovalId) || policy.needsApproval;
    const saleId = await submitOfflineCapable({
      set, name: "complete_sale", shopId: input.shopId, op,
      ...(approvalBound ? { mustSendNow: { offline: DISCOUNT_APPROVAL_OFFLINE_MESSAGE, backlog: DISCOUNT_APPROVAL_BACKLOG_MESSAGE } } : {}),
      // Step 4 (Part B): the value a sale recorded offline counts against the till's capability
      offlineAmountMmk: calculateCartTotals(input.cartItems, input.cartDiscountPct).total,
      args: buildCompleteSaleArgs(input, get, op),
      needsProvisionalRefs: isProvisionalShift(input.shiftId),
      applyOnline: (data, ackId) => applyCompleteSale(data, ackId, input.payments),
      stage: (stage) => stageSale(input, op, stage),
    });
    // 087 journal: which operation a printed receipt belongs to (opJournal.journalPrinted)
    rememberSaleOperation(saleId, op.idempotencyKey);
    return saleId;
  },

  // Called by the outbox once a queued complete_sale actually runs — swaps
  // the provisional sale/items/movements for the server's authoritative rows.
  reconcileCompleteSale: (data, provisional, ackId) => {
    const confirmed = withoutHiddenCost(data as CompleteSaleResult);
    // Server rows + the effects of other unresolved entries (stockLedger.ts).
    const shownStock = serverStockRows(confirmed.inventory, ackId ?? null);
    const provisionalSaleIds = new Set(provisional.find((p) => p.table === "sales")?.ids ?? []);
    // the queued split was confirmed with the sale: keep its payment lines (the reply carries none)
    const stagedPayments = get().sales.find((s) => provisionalSaleIds.has(s.id))?.payments;
    const result = stagedPayments?.length ? { ...confirmed, sale: { ...confirmed.sale, payments: stagedPayments } } : confirmed;
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
      inventory: mergeInventory(state.inventory, shownStock),
      movements: [...result.movements, ...state.movements.filter((m) => !provisionalMovementIds.has(m.id) && !resultMovementIds.has(m.id))],
      auditLogs: [...result.auditLogs, ...state.auditLogs.filter((a) => !resultAuditIds.has(a.id))],
    }));
    void deleteLocalRows(provisional);
    void putLocalRows({
      sales: [result.sale], saleItems: result.items,
      movements: result.movements, auditLogs: result.auditLogs,
    });
    // A void/refund request raised offline against this same sale (before it
    // had synced) will be queued with a ref to its provisional id — resolve
    // it now that the real one exists.
    const provisionalSaleId = [...provisionalSaleIds][0];
    if (provisionalSaleId) void recordIdMapping(provisionalSaleId, result.sale.id);
  },

  voidSale: async ({ saleId, reason }) => {
    const { data, error } = await callOnlineOnly("create_refund_void_request", {
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

  requestVoid: async ({ saleId, reason, actorId }) => submitRequest(saleId, "VOID", reason, undefined, actorId),

  requestRefund: async ({ saleId, items, reason }) => {
    // Step 4 (PFIN-E): the line detail (sale line, restock) and the payouts travel with the item, verbatim
    const payload = items.map((item) => ({
      productId: item.productId, qtyUnits: item.qtyUnits, amountMmk: item.amountMmk,
      ...(item.lines?.length ? { lines: item.lines.map((l) => ({ saleItemId: l.saleItemId, qtyUnits: l.qtyUnits, amountMmk: l.amountMmk, restock: l.restock })) } : {}),
      ...(item.payouts?.length ? { payouts: item.payouts.map((p) => ({ method: p.method, amountMmk: p.amountMmk })) } : {}),
    }));
    // Step 6 (PFIN-F): a refund request is recorded ONLINE ONLY (the server refuses one recorded offline with
    // FIN_REFUND_OFFLINE). Never queued: refused here before anything is saved or sent.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error(REFUND_OFFLINE_MESSAGE);
    }
    const sale = get().sales.find((s) => s.id === saleId);
    if (sale?.pendingSync) {
      throw new Error("Refunds are recorded online only, and this sale has not reached the server yet. Let it sync first. Nothing was saved.");
    }
    // ONE operation (onlineOnly.ts): its key is minted and saved before the first request; a lost reply is kept
    // unresolved under that key and only ever retried unchanged.
    const op = beginOperation();
    const { data, error } = await callOnlineOnly(
      "create_refund_void_request", buildRequestArgs(saleId, "PARTIAL", reason, payload, op), { retries: ONLINE_ONLY_RETRIES },
    );
    if (error) throw error;
    if (!data) throw new Error("Refund request returned no data.");
    await applyRefundVoidRequest(data);
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
    const { data, error } = await callOnlineOnly(
      rpcName, { p_request_id: refundId, p_idempotency_key: newIdempotencyKey() }, { retries: ONLINE_ONLY_RETRIES },
    );
    if (error) throw error;
    if (!data) throw new Error("Approval returned no data.");

    const result = data as ApprovalResult;
    // Server rows + the effects of other unresolved entries (stockLedger.ts);
    // never queued, so no entry of this till is released.
    const shownStock = serverStockRows(result.inventory, null);

    set((state) => ({
      refunds: mergeRefundRequest(state.refunds, result.request),
      refundVoidRequests: mergeRefundRequest(state.refundVoidRequests, result.request),
      sales: state.sales.map((sale) => (sale.id === result.sale.id ? result.sale : sale)),
      inventory: mergeInventory(state.inventory, shownStock),
      movements: [...result.movements, ...state.movements],
      auditLogs: [...result.auditLogs, ...state.auditLogs],
    }));
    // Step 4 (PFIN-E): a line refunded WITHOUT restock is taken back out of stock by a server trigger after the pinned
    // approval built its reply (RETURN_NO_RESTOCK), so the reply's stock is too high: read the server's stock again.
    const noRestock = (request.items ?? []).some((it) =>
      ((it as { lines?: { restock?: boolean }[] }).lines ?? []).some((l) => l.restock === false));
    if (noRestock) await get().refreshInventoryFromServer({ shopId: result.sale.shopId }).catch(() => undefined);
  },

  // Online only (a decision, like approval — never queued). The server
  // checks the request is still pending and the approver may decide it.
  rejectRefund: async ({ refundId, reason }) => {
    const { data, error } = await callOnlineOnly(
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
