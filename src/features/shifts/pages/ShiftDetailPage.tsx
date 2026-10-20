import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuthStore } from "../../../stores/authStore";
import { useDataStore } from "../../../stores/dataStore";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { PageHeader } from "../../../components/layout/PageHeader";
import { Table, TBody, TD, TH, THead, TR } from "../../../components/ui/Table";
import { useToast } from "../../../components/ui/Toast";
import { ShiftDetail } from "../../../components/shifts/ShiftDetail";
import { EndShiftCard } from "../../../components/shifts/EndShiftCard";
import { buildShiftBreakdown } from "../service";
import { useShiftReconciliation } from "../../reports/useFinReport";
import { ShiftReconciliationPanel } from "../components/ShiftReconciliationPanel";
import { checkExpectedBeforeClose, extraReasonError } from "../closeExpected";
import { closeWouldExpect } from "../../reports/finReports";
import {
  canUserCloseShift,
  getSalesForShift,
  getVisibleShiftsForUser,
  validateCloseShift,
} from "../shiftRecords";
import { formatDateTime, formatMmk } from "../../../lib/utils";
import { getErrorMessage } from "../../../lib/errors";

const SHIFTS_ROUTE = "/app/shifts";

export const ShiftDetailPage = () => {
  const { shiftId } = useParams<{ shiftId: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((u) => u.id === currentUserId));
  const shops = useDataStore((state) => state.shops);
  const users = useDataStore((state) => state.users);
  const shifts = useDataStore((state) => state.shifts);
  const sales = useDataStore((state) => state.sales);
  const saleItems = useDataStore((state) => state.saleItems);
  const products = useDataStore((state) => state.products);
  const refundVoidRequests = useDataStore((state) => state.refundVoidRequests);
  const endShift = useDataStore((state) => state.endShift);

  // Live clock for "Active" shift durations. Same 30s cadence ShiftsPage
  // uses so the two surfaces tick together.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Close-shift form local state. Mirrors the fields the closer needs
  // and never leaks back into other surfaces — leaving the page resets
  // everything via component unmount.
  const [closingCash, setClosingCash] = useState<number | undefined>(undefined);
  const [varianceReason, setVarianceReason] = useState("");
  const [closeAttempted, setCloseAttempted] = useState(false);
  const [expandedSaleIds, setExpandedSaleIds] = useState<Set<string>>(new Set());

  const visibleShifts = useMemo(
    () => getVisibleShiftsForUser(shifts, currentUser),
    [currentUser, shifts],
  );
  const shift = useMemo(() => visibleShifts.find((s) => s.id === shiftId), [visibleShifts, shiftId]);
  const shiftSales = useMemo(
    () => (shift ? getSalesForShift(sales, shift.id) : []),
    [sales, shift],
  );
  const breakdown = useMemo(
    () => (shift ? buildShiftBreakdown(shift, shiftSales, refundVoidRequests) : null),
    [shift, shiftSales, refundVoidRequests],
  );
  // Server reconciliation (every approved refund, whoever entered it; never
  // the client cache). The close form uses its expected cash when it is
  // available; otherwise the device's figure, labelled as an estimate (the
  // server recomputes expected cash when the close is applied).
  const recon = useShiftReconciliation(shift?.id ?? null);
  const serverExpected = recon.state.status === "ok" ? closeWouldExpect(recon.state.data) : null;
  const closeExpectedCash = serverExpected ?? breakdown?.expectedCash ?? 0;

  // Pre-compute "sales sorted newest-first + line items grouped by sale"
  // so the render path doesn't repeat the filter per row. saleItems is
  // a flat list across the whole store; the grouping is what keeps the
  // expansion subtable cheap to render.
  const sortedSales = useMemo(
    () => shiftSales.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [shiftSales],
  );
  const lineItemsBySaleId = useMemo(() => {
    const map = new Map<string, typeof saleItems>();
    for (const sale of sortedSales) {
      map.set(sale.id, saleItems.filter((item) => item.saleId === sale.id));
    }
    return map;
  }, [saleItems, sortedSales]);

  const baseCloseValidation = breakdown
    ? validateCloseShift({
        closingCash,
        expectedCash: closeExpectedCash,
        varianceReason,
      })
    : { variance: null, canClose: false, error: null };
  const deviceReasonError = baseCloseValidation.canClose
    ? extraReasonError({ closingCash, shownExpectedMmk: closeExpectedCash, deviceExpectedMmk: breakdown?.expectedCash, varianceReason })
    : null;
  const closeValidation = deviceReasonError
    ? { ...baseCloseValidation, canClose: false, error: deviceReasonError }
    : baseCloseValidation;
  const canClose = !!shift && canUserCloseShift(currentUser, shift);

  const handleEndShift = async () => {
    if (!shift || !breakdown) return;
    if (recon.state.status === "loading") {
      toast({ title: "Checking expected cash", description: "The server reconciliation is still loading. Try again in a moment.", variant: "error" });
      return;
    }
    if (!canClose) {
      toast({ title: "No permission", description: "You cannot close this shift.", variant: "error" });
      return;
    }
    setCloseAttempted(true);
    if (!closeValidation.canClose) {
      toast({
        title: "Cannot close shift",
        description: closeValidation.error ?? "Check the closing cash fields.",
        variant: "error",
      });
      return;
    }
    const check = await checkExpectedBeforeClose(shift.id, closeExpectedCash);
    if (!check.proceed) {
      recon.refresh();
      toast({
        title: "Expected cash changed",
        description: `The server now expects ${formatMmk(check.latestMmk)} (a refund or void was approved meanwhile). Check the count and close again.`,
        variant: "error",
      });
      return;
    }
    try {
      await endShift({
        shiftId: shift.id,
        closingCashMmk: closingCash ?? 0,
        // a typed reason is always sent: the server's own variance may differ from the form's
        varianceReason: varianceReason.trim() !== "" ? varianceReason.trim() : undefined,
      });
      toast({ title: "Shift closed", variant: "success" });
      navigate(SHIFTS_ROUTE);
    } catch (error) {
      toast({
        title: "Could not close shift",
        description: getErrorMessage(error, "Failed to close shift."),
        variant: "error",
      });
    }
  };

  const toggleExpanded = (saleId: string) => {
    setExpandedSaleIds((prev) => {
      const next = new Set(prev);
      if (next.has(saleId)) next.delete(saleId);
      else next.add(saleId);
      return next;
    });
  };

  // Aggregate top items sold across this shift. Skips voided/refunded
  // lines so the rollup matches the cash drawer expectation, not the
  // raw ring-up count.
  const topItems = useMemo(() => {
    const counters = new Map<string, { name: string; qty: number; total: number }>();
    for (const sale of sortedSales) {
      if (sale.status !== "NORMAL") continue;
      for (const item of lineItemsBySaleId.get(sale.id) ?? []) {
        const product = products.find((p) => p.id === item.productId);
        const name = product?.name ?? item.productId;
        const current = counters.get(item.productId) ?? { name, qty: 0, total: 0 };
        const qty = item.baseQuantitySold ?? item.qtyUnits;
        current.qty += qty;
        current.total += item.lineTotalMmk;
        counters.set(item.productId, current);
      }
    }
    return Array.from(counters.values()).sort((a, b) => b.total - a.total);
  }, [sortedSales, lineItemsBySaleId, products]);

  if (!currentUser) return null;

  if (!shift || !breakdown) {
    return (
      <Card>
        <PageHeader
          title="Shift not found"
          subtitle="This shift may have been removed, or you don't have access to it."
          actions={
            <Button variant="secondary" onClick={() => navigate(SHIFTS_ROUTE)}>
              <span className="material-symbols-rounded mr-1 text-sm">arrow_back</span>
              Back to Shifts
            </Button>
          }
        />
      </Card>
    );
  }

  const cashier = users.find((u) => u.id === shift.cashierId);
  const shopName = shops.find((s) => s.id === shift.shopId)?.name;

  return (
    <Card>
      <Link to={SHIFTS_ROUTE} className="text-sm text-slate-500 hover:underline">
        ← Back to Shifts
      </Link>

      <PageHeader
        title={`Shift · ${cashier?.name ?? shift.cashierId}`}
        subtitle={`${shopName ?? shift.shopId} · started ${formatDateTime(shift.startedAt)}`}
      />

      <div className="mt-6 space-y-6">
        <ShiftDetail
          shift={shift}
          cashierName={cashier?.name}
          cashierRole={cashier?.role}
          shopName={shopName}
          breakdown={breakdown}
          // Sales are rendered in the richer table below — passing an
          // empty array suppresses the legacy compact summary inside
          // ShiftDetail so we don't duplicate the data.
          sales={[]}
          now={now}
        />

        {/* Items rolled up across the shift. Useful for end-of-day
            reviews ("what did this cashier mostly sell?") and matches
            the workflow legacy POS owners expect from a shift report. */}
        <div className="rounded-2xl border border-slate-200/70 bg-white">
          <div className="border-b border-slate-100 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            Items sold (excludes voided sales)
          </div>
          {topItems.length === 0 ? (
            <div className="px-3 py-4 text-sm text-slate-500">
              No items recorded in this shift.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[480px]">
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH className="text-right">Qty</TH>
                    <TH className="text-right">Revenue</TH>
                  </TR>
                </THead>
                <TBody>
                  {topItems.map((row) => (
                    <TR key={row.name}>
                      <TD>{row.name}</TD>
                      <TD className="text-right tabular-nums">{row.qty}</TD>
                      <TD className="text-right tabular-nums">{formatMmk(row.total)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </div>

        {/* Per-sale table with expandable line items. Mirrors the legacy
            iStock sale list (Date / User / Ref / PayType / Qty / Paid /
            Total) but adds an Items toggle so a manager can drill into
            any receipt without leaving the page. */}
        <div className="rounded-2xl border border-slate-200/70 bg-white">
          <div className="border-b border-slate-100 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            Sales in this shift ({sortedSales.length})
          </div>
          {sortedSales.length === 0 ? (
            <div className="px-3 py-4 text-sm text-slate-500">
              No sales were recorded in this shift.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[820px]">
                <THead>
                  <TR>
                    <TH>Time</TH>
                    <TH>Receipt</TH>
                    <TH>User</TH>
                    <TH>Payment</TH>
                    <TH className="text-right">Qty</TH>
                    <TH className="text-right">Discount</TH>
                    <TH className="text-right">Paid</TH>
                    <TH className="text-right">Change</TH>
                    <TH className="text-right">Total</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {sortedSales.map((sale) => {
                    const items = lineItemsBySaleId.get(sale.id) ?? [];
                    const totalQty = items.reduce(
                      (sum, item) => sum + (item.baseQuantitySold ?? item.qtyUnits),
                      0,
                    );
                    const expanded = expandedSaleIds.has(sale.id);
                    const isVoid = sale.status === "VOID";
                    return [
                      <TR key={sale.id} className={isVoid ? "opacity-70" : undefined}>
                        <TD className="whitespace-nowrap text-xs text-slate-600">
                          {formatDateTime(sale.createdAt)}
                        </TD>
                        <TD className="font-medium text-slate-800">#{sale.receiptNo}</TD>
                        <TD>{cashier?.name ?? sale.cashierId}</TD>
                        <TD>{sale.paymentMethod}</TD>
                        <TD className="text-right tabular-nums">{totalQty}</TD>
                        <TD className="text-right tabular-nums text-slate-500">
                          {sale.discountMmk > 0 ? formatMmk(sale.discountMmk) : "-"}
                        </TD>
                        <TD className="text-right tabular-nums">{formatMmk(sale.paidMmk)}</TD>
                        <TD className="text-right tabular-nums text-slate-500">
                          {formatMmk(sale.changeMmk)}
                        </TD>
                        <TD className="text-right tabular-nums font-medium">
                          {formatMmk(isVoid ? 0 : sale.totalMmk)}
                        </TD>
                        <TD>
                          <Badge tone={isVoid ? "red" : sale.status === "REFUNDED" ? "amber" : "green"}>
                            {sale.status}
                          </Badge>
                        </TD>
                        <TD className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleExpanded(sale.id)}
                              title="Show / hide items"
                            >
                              <span className="material-symbols-rounded text-sm">
                                {expanded ? "expand_less" : "expand_more"}
                              </span>
                            </Button>
                            <Link
                              to={`/app/sales/${sale.id}`}
                              className="rounded p-1 text-slate-500 hover:bg-slate-100"
                              title="Open receipt"
                            >
                              <span className="material-symbols-rounded text-sm">
                                open_in_new
                              </span>
                            </Link>
                          </div>
                        </TD>
                      </TR>,
                      expanded && (
                        <TR key={`${sale.id}-items`} className="bg-slate-50/60">
                          <TD colSpan={11}>
                            {items.length === 0 ? (
                              <div className="px-3 py-2 text-xs text-slate-500">
                                No line items recorded.
                              </div>
                            ) : (
                              <div className="px-3 py-3">
                                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                  Items on this receipt
                                </div>
                                <table className="w-full text-xs">
                                  <thead className="text-left text-slate-500">
                                    <tr>
                                      <th className="py-1 font-medium">Product</th>
                                      <th className="py-1 font-medium">Unit</th>
                                      <th className="py-1 text-right font-medium">Qty</th>
                                      <th className="py-1 text-right font-medium">Unit Price</th>
                                      <th className="py-1 text-right font-medium">Discount</th>
                                      <th className="py-1 text-right font-medium">Line Total</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-200">
                                    {items.map((item) => {
                                      const product = products.find((p) => p.id === item.productId);
                                      const unitName = item.unitNameSnapshot ?? item.unitLabel ?? "Unit";
                                      const baseQuantity =
                                        item.unitBaseQuantitySnapshot ?? item.unitsPerItem ?? 1;
                                      const soldBaseQuantity = item.baseQuantitySold ?? item.qtyUnits;
                                      const soldUnitQty =
                                        baseQuantity > 0 ? soldBaseQuantity / baseQuantity : item.qtyUnits;
                                      const unitPrice = item.unitPriceMmkSnapshot ?? item.unitPriceMmk;
                                      return (
                                        <tr key={item.id ?? `${sale.id}-${item.productId}-${item.qtyUnits}`}>
                                          <td className="py-1">{product?.name ?? item.productId}</td>
                                          <td className="py-1 text-slate-600">{unitName}</td>
                                          <td className="py-1 text-right tabular-nums">{soldUnitQty}</td>
                                          <td className="py-1 text-right tabular-nums">
                                            {formatMmk(unitPrice)}
                                          </td>
                                          <td className="py-1 text-right tabular-nums text-slate-500">
                                            {item.itemDiscountPct ? `${item.itemDiscountPct}%` : "-"}
                                          </td>
                                          <td className="py-1 text-right tabular-nums font-medium">
                                            {formatMmk(item.lineTotalMmk)}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </TD>
                        </TR>
                      ),
                    ];
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 pt-4">
          <ShiftReconciliationPanel state={recon.state} onRetry={recon.refresh} />
        </div>

        {canClose && (
          <div className="border-t border-slate-200 pt-4">
            <div className="mb-3">
              <div className="text-sm font-semibold text-slate-800">Close this shift</div>
              <div className="text-xs text-slate-500" data-close-expected-source={serverExpected !== null ? "server" : "device"}>
                {serverExpected !== null
                  ? "Expected cash from the server reconciliation above. The backend recomputes it on close."
                  : "Server reconciliation unavailable: expected cash is this device's estimate from loaded sales. The backend recomputes it on close."}
              </div>
            </div>
            <EndShiftCard
              idPrefix={`detail-${shift.id}`}
              closingCash={closingCash}
              expectedCash={closeExpectedCash}
              varianceReason={varianceReason}
              onVarianceReasonChange={setVarianceReason}
              onClosingCashChange={(next) => {
                setClosingCash(next);
                setCloseAttempted(false);
              }}
              onEnd={handleEndShift}
              error={closeAttempted ? closeValidation.error : null}
              submitLabel="Close shift"
            />
          </div>
        )}
      </div>
    </Card>
  );
};
