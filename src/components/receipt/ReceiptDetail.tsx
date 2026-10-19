import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { useDataStore } from "../../stores/dataStore";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { PageHeader } from "../layout/PageHeader";
import { useToast } from "../ui/Toast";
import { ReceiptPreview } from "../pos/ReceiptPreview";
import { SaleVoucher } from "../sales/SaleVoucher";
import { RefundModal } from "../sales/RefundModal";
import { VoidModal } from "../sales/VoidModal";
import { buildRefundState, planRefundRequest } from "../../features/sales/service";
import { hasPermission } from "../../lib/permissions";
import { formatDateTime } from "../../lib/utils";
import { printReceipt } from "../../lib/print";
import { journalReceiptPrint } from "../../stores/data/opJournal";
import { useTranslation } from "../../hooks/useTranslation";

interface ReceiptDetailProps {
  saleId: string;
  /**
   * "page" (default) renders the full PageHeader with Print/Reprint in the
   * header actions. "drawer" omits the PageHeader and renders a compact
   * inline toolbar so the same body can live inside the Drawer primitive.
   */
  variant?: "page" | "drawer";
  backTo?: string;
}

export const ReceiptDetail = ({ saleId, variant = "page", backTo }: ReceiptDetailProps) => {
  const toast = useToast();
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const { t } = useTranslation();
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const sale = useDataStore((state) => state.sales.find((item) => item.id === saleId));
  const allSaleItems = useDataStore((state) => state.saleItems);
  const products = useDataStore((state) => state.products);
  const shops = useDataStore((state) => state.shops);
  const users = useDataStore((state) => state.users);
  const allReprintLogs = useDataStore((state) => state.reprintLogs);
  const allRefunds = useDataStore((state) => state.refunds);
  const addReprintLog = useDataStore((state) => state.addReprintLog);
  const requestVoid = useDataStore((state) => state.requestVoid);
  const requestRefund = useDataStore((state) => state.requestRefund);
  const approveRefund = useDataStore((state) => state.approveRefund);

  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundReason, setRefundReason] = useState("");
  const [refundSelection, setRefundSelection] = useState<Record<string, number>>({});
  const [reprintInFlight, setReprintInFlight] = useState(false);

  const saleItems = useMemo(
    () => allSaleItems.filter((item) => item.saleId === saleId),
    [allSaleItems, saleId]
  );
  const reprintLogs = useMemo(
    () => allReprintLogs.filter((item) => item.saleId === saleId),
    [allReprintLogs, saleId]
  );
  const refundsForSale = useMemo(
    () => allRefunds.filter((refund) => refund.saleId === saleId),
    [allRefunds, saleId]
  );

  if (!sale) {
    return (
      <div className="space-y-4">
        {variant === "page" && backTo && (
          <Link to={backTo} className="text-sm text-slate-500 hover:underline">
            ← Back to sales
          </Link>
        )}
        <div className="p-8 text-center text-slate-500">Receipt not found.</div>
      </div>
    );
  }

  const shop = shops.find((item) => item.id === sale.shopId) ?? {
    id: sale.shopId, code: "SHOP", name: "Store", address: "",
    isActive: true, createdAt: sale.createdAt,
  };
  const cashier = users.find((item) => item.id === sale.cashierId);
  const productNames = Object.fromEntries(products.map((p) => [p.id, p.name]));
  const lines = saleItems.map((item) => {
    const product = products.find((p) => p.id === item.productId);
    const unitName = item.unitNameSnapshot ?? item.unitLabel ?? "Unit";
    const baseQuantity = item.unitBaseQuantitySnapshot ?? item.unitsPerItem ?? 1;
    const soldBaseQuantity = item.baseQuantitySold ?? item.qtyUnits;
    const soldUnitQty = baseQuantity > 0 ? soldBaseQuantity / baseQuantity : item.qtyUnits;
    const unitPrice = item.unitPriceMmkSnapshot ?? item.unitPriceMmk;
    return {
      // Receipt rows split into proper columns (Description / Qty / Price /
      // Amount) so cashiers and customers can scan the figures the way
      // they're used to on a paper roll. Price level snapshot is rendered
      // separately by ReceiptPreview, not concatenated into the name.
      // `code` is consumed by the on-screen voucher's Code column; the
      // thermal ReceiptPreview ignores the extra field.
      code: product?.sku ?? product?.aliasCode ?? "",
      name: product?.name ?? item.productId,
      qty: soldUnitQty,
      unitLabel: unitName,
      unitPriceMmk: unitPrice,
      lineTotalMmk: item.lineTotalMmk,
      priceLevelName: item.priceLevelNameSnapshot,
    };
  });

  const canReprint = hasPermission(currentUser, "receipt:reprint");
  const canRequestVoid = hasPermission(currentUser, "pos:request_void");
  const canRequestRefund = hasPermission(currentUser, "pos:request_refund");
  const canApproveVoid = hasPermission(currentUser, "pos:void_sale");
  const canApproveRefund = hasPermission(currentUser, "pos:refund");
  const isNormal = sale.status === "NORMAL";
  const pendingRequests = refundsForSale.filter((r) => r.status === "REQUESTED");
  // Refund state from the net amounts actually paid (refundMath.ts): what is
  // left to refund per line, and whether the sale is only partly refunded
  // (the server marks any refunded sale REFUNDED, ORV-030).
  const refundState = buildRefundState(sale, saleItems, refundsForSale);
  const refundPlan = planRefundRequest(refundState, refundSelection);
  const hasRefundableUnits = refundState.lines.some((line) => !line.ambiguous && line.remainingSoldUnits > 0);
  const statusNote = refundState.partiallyRefunded
    ? "PARTIALLY REFUNDED"
    : sale.status !== "NORMAL" ? sale.status : undefined;

  // Print and Reprint both require at least one sale item. complete_sale
  // is transactional so this should always be true in practice; if items
  // were never loaded the buttons are disabled rather than emitting an
  // empty receipt.
  // An UNCONFIRMED sale (its outcome is unknown) never prints as a final
  // receipt — it may not exist on the server (Batch 2A correction pass).
  const unconfirmed = sale.pendingConfirmation === true;
  const hasPrintableContent = saleItems.length > 0 && !unconfirmed;

  // 087: the printed receipt number is journaled before anything prints (fail closed)
  const journalThenPrint = async () => {
    try {
      await journalReceiptPrint(sale);
    } catch (error) {
      toast({ title: "Receipt not printed", description: `This till could not record the receipt number in its journal (${error instanceof Error ? error.message : String(error)}).`, variant: "error" });
      return;
    }
    void printReceipt();
  };

  const handlePrint = () => {
    if (!hasPrintableContent) return;
    void journalThenPrint();
  };

  const handleReprint = async () => {
    if (!hasPrintableContent || reprintInFlight) return;
    setReprintInFlight(true);
    try {
      if (currentUserId) await addReprintLog({ saleId: sale.id, actorId: currentUserId });
      await journalThenPrint();
    } catch (error) {
      toast({
        title: "Reprint log failed",
        description: error instanceof Error ? error.message : "Could not record the reprint.",
        variant: "error",
      });
    } finally {
      setReprintInFlight(false);
    }
  };

  const handleRequestVoid = async () => {
    if (!currentUserId) return;
    try {
      await requestVoid({ saleId: sale.id, reason: voidReason || "No reason", actorId: currentUserId });
      setVoidOpen(false);
      setVoidReason("");
      toast({ title: "Void request submitted", variant: "success" });
    } catch (error) {
      toast({
        title: "Void request failed",
        description: error instanceof Error ? error.message : "Could not submit the void request.",
        variant: "error",
      });
    }
  };

  const handleRequestRefund = async () => {
    if (!currentUserId) return;
    if (refundPlan.items.length === 0 || refundPlan.errors.length > 0) return;
    const items = refundPlan.items;
    try {
      await requestRefund({ saleId: sale.id, items, reason: refundReason || "No reason", actorId: currentUserId });
      setRefundOpen(false);
      setRefundReason("");
      setRefundSelection({});
      toast({ title: "Refund request submitted", variant: "success" });
    } catch (error) {
      toast({
        title: "Refund request failed",
        description: error instanceof Error ? error.message : "Could not submit the refund request.",
        variant: "error",
      });
    }
  };

  const handleApprove = async (refundId: string) => {
    if (!currentUserId) return;
    try {
      await approveRefund({ refundId, approverId: currentUserId });
      toast({ title: "Approval completed", variant: "success" });
    } catch (error) {
      toast({
        title: "Approval failed",
        description: error instanceof Error ? error.message : "Could not approve the request.",
        variant: "error",
      });
    }
  };

  // Void: only an untouched sale (the server voids NORMAL sales only).
  // Refund: any non-void sale with units left and no refund already waiting.
  const showVoidRequest = canRequestVoid && isNormal && !refundState.hasApprovedRefund;
  const showRefundRequest = canRequestRefund && sale.status !== "VOID" && hasRefundableUnits && !refundState.hasPendingRefund;
  const showRequestActions = showVoidRequest || showRefundRequest;
  // The server refuses approving one's own request: do not offer it.
  const visibleApprovals = pendingRequests.filter(
    (r) => (r.type === "VOID" ? canApproveVoid : canApproveRefund) && r.createdBy !== currentUserId
  );

  const printToolbar = (
    <div className="flex flex-wrap items-center gap-2 print-hidden">
      <Button variant="secondary" onClick={handlePrint} disabled={!hasPrintableContent || reprintInFlight}>
        Print
      </Button>
      {canReprint && (
        <Button onClick={() => void handleReprint()} disabled={!hasPrintableContent || reprintInFlight}>
          {reprintInFlight ? "Reprinting…" : "Reprint"}
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      {variant === "page" && backTo && (
        <Link to={backTo} className="text-sm text-slate-500 hover:underline print-hidden">
          ← Back to sales
        </Link>
      )}

      {variant === "page" ? (
        <PageHeader
          title="Sales Voucher"
          subtitle="Itemized sale detail. Use Print for the 80mm receipt."
          actions={printToolbar}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-slate-500">
            {sale.paymentMethod} • {formatDateTime(sale.createdAt)}
          </div>
          {printToolbar}
        </div>
      )}

      {unconfirmed ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 print-hidden">
          {t("unresolved", "pendingTitle")}: {t("unresolved", "pendingSaleBody")}
        </div>
      ) : !hasPrintableContent && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 print-hidden">
          Sale items are still loading or unavailable; printing is disabled until items are visible.
        </div>
      )}

      {variant === "page" ? (
        // Full page: themed voucher grid on the left, the live receipt
        // preview (logo + branding + totals) on the right. The same
        // `.receipt` node is what Print / Reprint output — the print CSS
        // isolates it regardless of where it sits on screen.
        <SaleVoucher
          sale={sale}
          lines={lines}
          shop={shop}
          cashier={cashier}
          aside={
            <ReceiptPreview
              sale={sale}
              lines={lines}
              shop={shop}
              cashier={cashier}
              statusNote={statusNote}
            />
          }
        />
      ) : (
        <ReceiptPreview
          sale={sale}
          lines={lines}
          shop={shop}
          cashier={cashier}
          statusNote={statusNote}
        />
      )}

      <Card>
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-slate-700">Reprint log</div>
          <div className="text-xs text-slate-400">{reprintLogs.length} total</div>
        </div>
        <div className="mt-3 space-y-2 text-sm">
          {reprintLogs.length === 0 ? (
            <div className="text-xs text-slate-400">No reprints yet.</div>
          ) : (
            reprintLogs.map((log) => (
              <div key={log.id} className="flex items-center justify-between">
                <span>{users.find((user) => user.id === log.printedBy)?.name ?? log.printedBy}</span>
                <span className="text-xs text-slate-400">{formatDateTime(log.printedAt)}</span>
              </div>
            ))
          )}
        </div>
      </Card>

      {showRequestActions && (
        <Card>
          <div className="text-sm font-medium text-slate-700">Request actions</div>
          <p className="mt-1 text-xs text-slate-500">Requests require manager approval.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {showVoidRequest && (
              <Button variant="danger" onClick={() => setVoidOpen(true)}>Request void</Button>
            )}
            {showRefundRequest && (
              <Button variant="secondary" onClick={() => setRefundOpen(true)}>Request refund</Button>
            )}
          </div>
        </Card>
      )}

      {visibleApprovals.length > 0 && (
        <Card>
          <div className="text-sm font-medium text-slate-700">Pending approvals</div>
          <div className="mt-3 space-y-2">
            {visibleApprovals.map((refund) => (
              <div key={refund.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">{refund.type === "VOID" ? "Void request" : "Refund request"}</div>
                  <div className="truncate text-xs text-slate-500">
                    Requested {formatDateTime(refund.createdAt)} — {refund.reason}
                  </div>
                </div>
                <Button onClick={() => void handleApprove(refund.id)}>Approve {refund.type}</Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <VoidModal
        open={voidOpen}
        reason={voidReason}
        onChangeReason={setVoidReason}
        onClose={() => setVoidOpen(false)}
        onConfirm={() => void handleRequestVoid()}
      />

      <RefundModal
        open={refundOpen}
        lines={refundState.lines}
        selection={refundSelection}
        plan={refundPlan}
        reason={refundReason}
        productNames={productNames}
        onChangeSelection={(lineKey, units) => setRefundSelection((prev) => ({ ...prev, [lineKey]: units }))}
        onChangeReason={setRefundReason}
        onClose={() => setRefundOpen(false)}
        onSubmit={() => void handleRequestRefund()}
      />
    </div>
  );
};
