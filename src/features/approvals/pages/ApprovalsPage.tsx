import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthStore } from "../../../stores/authStore";
import { useAppStore } from "../../../stores/appStore";
import { useDataStore } from "../../../stores/dataStore";
import { PageHeader } from "../../../components/layout/PageHeader";
import { Card } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Modal } from "../../../components/ui/Modal";
import { useToast } from "../../../components/ui/Toast";
import { ReasonDialog } from "../../../components/ui/ReasonDialog";
import { formatDateTime, formatMmk, getEffectiveShopId } from "../../../lib/utils";
import { hasShopPermission } from "../../../lib/permissions";
import { useTranslation } from "../../../hooks/useTranslation";
import { refundRequestExcessMmk } from "../../sales/service";
import {
  altPayoutDetails, decideFinApproval, discountDetails, fetchFinApprovals, finStep6Capabilities, priceAdjustDetails,
  type FinApproval, type MethodAmount,
} from "../../finance/finCompletion";
import type { FinResult } from "../../reports/finReports";
import type { User } from "../../../types";

/** Step 6 (PFIN-F): a Shop Admin of the shop — fin:approve_exception for that shop (an ADMIN holds it by default; it can be
 *  granted to a manager and revoked per user). The server decides (fin_is_shop_admin); this only words the hint. */
const isShopAdmin = (user: User | undefined, shopId: string): boolean => hasShopPermission(user, "fin:approve_exception", shopId);

export const ApprovalsPage = () => {
  const toast = useToast();
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const refunds = useDataStore((state) => state.refundVoidRequests);
  const shops = useDataStore((state) => state.shops);
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const { currentShopId } = useAppStore();
  const sales = useDataStore((state) => state.sales);
  const saleItems = useDataStore((state) => state.saleItems);
  const users = useDataStore((state) => state.users);
  const approveRefund = useDataStore((state) => state.approveRefund);
  const rejectRefund = useDataStore((state) => state.rejectRefund);
  const products = useDataStore((state) => state.products);
  const { t } = useTranslation();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);

  const shopId = getEffectiveShopId(currentUser, currentShopId, shops);
  const pending = refunds.filter(
    (refund) => refund.status === "REQUESTED" && (!shopId || refund.shopId === shopId)
  );
  const saleMap = useMemo(() => Object.fromEntries(sales.map((sale) => [sale.id, sale])), [sales]);
  const userMap = useMemo(() => Object.fromEntries(users.map((user) => [user.id, user])), [users]);

  // ---- Step 6 (PFIN-F / PDISC-A): exception approvals (fin_approvals), decided online by a Shop Admin
  const [exceptionsAvailable, setExceptionsAvailable] = useState(false);
  const [exceptions, setExceptions] = useState<FinResult<FinApproval[]> | null>(null);
  const [exceptionBusy, setExceptionBusy] = useState<string | null>(null);
  const [rejectingException, setRejectingException] = useState<FinApproval | null>(null);
  const pendingIdsKey = pending.map((r) => r.id).join(",");
  useEffect(() => {
    let live = true;
    void finStep6Capabilities().then((c) => { if (live) setExceptionsAvailable(c.splitRefunds); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const loadExceptions = useCallback(async () => {
    if (!exceptionsAvailable) return;
    const res = await fetchFinApprovals({ shopId, subjectIds: pendingIdsKey ? pendingIdsKey.split(",") : [] });
    setExceptions(res);
  }, [exceptionsAvailable, shopId, pendingIdsKey]);
  useEffect(() => { void loadExceptions(); }, [loadExceptions]);
  const exceptionList = exceptions?.status === "ok" ? exceptions.data : [];
  const waitingExceptions = exceptionList.filter((a) => a.status === "REQUESTED");
  const exceptionsOf = (requestId: string) => exceptionList.filter((a) => a.subjectId === requestId && a.status !== "APPROVED");
  const saleItemNames = useMemo(() => {
    const productName = Object.fromEntries(products.map((p) => [p.id, p.name]));
    return Object.fromEntries(saleItems.map((si) => [si.id, productName[si.productId] ?? si.productId]));
  }, [products, saleItems]);
  const methodLabel = (m: string) => ({
    CASH: t("fin", "methodCash"), BANK_TRANSFER: t("fin", "methodBank"), MOBILE_WALLET: t("fin", "methodWallet"),
    CARD: t("fin", "methodCard"), OTHER: t("fin", "methodOther"),
  } as Record<string, string>)[m] ?? m;
  const methodList = (list: MethodAmount[]) => list.map((p) => `${methodLabel(p.method)} ${formatMmk(p.amountMmk)}`).join(" · ") || "—";
  const kindLabel = (a: FinApproval) =>
    a.kind === "DISCOUNT" ? t("fin6", "kindDiscount") : a.kind === "REFUND_ALT_PAYOUT" ? t("fin6", "kindAltPayout") : t("fin6", "kindPriceAdjust");
  const mayDecide = (a: FinApproval): boolean => {
    if (isShopAdmin(currentUser, a.shopId)) return true;
    // PDISC-A: a cashier's discount the server marked as NOT needing a Shop Admin (its exact whole-MMK test,
    // details.needsShopAdmin — never the rounded pct) may also be decided by a manager holding pos:apply_discount
    return a.kind === "DISCOUNT" && a.details.needsShopAdmin === false && (currentUser?.role === "MANAGER" || currentUser?.role === "ADMIN")
      && hasShopPermission(currentUser, "pos:apply_discount", a.shopId);
  };

  const decide = async (a: FinApproval, decision: "APPROVE" | "REJECT", reason: string | null): Promise<boolean> => {
    if (exceptionBusy) return false;
    setExceptionBusy(a.id);
    try {
      await decideFinApproval(a.id, decision, reason);
      toast({ title: t("fin6", "decided"), variant: "success" });
      return true;
    } catch (error) {
      toast({ title: t("fin6", "decideFailed"), description: error instanceof Error ? error.message : String(error), variant: "error" });
      return false;
    } finally {
      setExceptionBusy(null);
      await loadExceptions();
    }
  };
  const confirmRejectException = async (why: string) => {
    const a = rejectingException;
    if (!a) return;
    const reason = why.trim();
    if (reason.length < 3 || reason.length > 300) {      // the server's rule (3–300); the dialog itself allows 500
      toast({ title: t("fin6", "decideFailed"), description: t("fin6", "reasonLength"), variant: "error" });
      throw new Error("reason length");                  // keeps the dialog open with the typed reason
    }
    if (!(await decide(a, "REJECT", reason))) throw new Error("rejection refused");
  };

  const renderDetails = (a: FinApproval) => {
    if (a.kind === "DISCOUNT") {
      const d = discountDetails(a);
      return (
        <div className="text-xs text-slate-600">
          {t("fin6", "cartDiscount", { ref: formatMmk(d.referenceSubtotalMmk), disc: formatMmk(d.discountMmk), pct: Number.isFinite(d.pct) ? d.pct.toFixed(2) : "?" })}
          {d.needsShopAdmin ? <Badge tone="amber" className="ml-2">{t("fin6", "needsShopAdminTag")}</Badge> : null}
        </div>
      );
    }
    if (a.kind === "REFUND_ALT_PAYOUT") {
      const d = altPayoutDetails(a);
      return (
        <div className="space-y-0.5 text-xs text-slate-600">
          <div>{saleMap[d.saleId]?.receiptNo ?? d.saleId}</div>
          <div>{t("fin6", "original")}: {methodList(d.original)}</div>
          <div className="font-medium text-slate-800">{t("fin6", "proposed")}: {methodList(d.proposed)}</div>
        </div>
      );
    }
    const d = priceAdjustDetails(a);
    return (
      <div className="space-y-0.5 text-xs text-slate-600">
        <div>{saleMap[d.saleId]?.receiptNo ?? d.saleId}</div>
        {d.lines.map((l) => (
          <div key={l.saleItemId}>
            {t("fin6", "lineAdjust", { line: saleItemNames[l.saleItemId] ?? l.saleItemId, qty: l.qtyUnits, from: formatMmk(l.defaultMmk), to: formatMmk(l.proposedMmk) })}
          </div>
        ))}
      </div>
    );
  };

  const handleApprove = async (requestId: string) => {
    if (!currentUserId || busyId) return;
    setBusyId(requestId);
    try {
      await approveRefund({ refundId: requestId, approverId: currentUserId });
      toast({ title: "Approval completed", variant: "success" });
    } catch (error) {
      toast({
        title: "Approval failed",
        description: error instanceof Error ? error.message : "Could not approve the request.",
        variant: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async () => {
    if (!rejecting || busyId) return;
    const reason = rejecting.reason.trim();
    if (!reason) return;
    setBusyId(rejecting.id);
    try {
      await rejectRefund({ refundId: rejecting.id, reason });
      setRejecting(null);
      toast({ title: "Request rejected", variant: "success" });
    } catch (error) {
      toast({
        title: "Rejection failed",
        description: error instanceof Error ? error.message : "Could not reject the request.",
        variant: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" subtitle="Review refund and void requests from cashiers." />
      <Card>
        {pending.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
            No pending approvals.
          </div>
        ) : (
          <div className="space-y-4">
            {pending.map((request) => {
              const sale = saleMap[request.saleId];
              const creator = userMap[request.createdBy];
              const own = request.createdBy === currentUserId;
              const amount = (request.items ?? []).reduce((sum, item) => sum + (Number(item.amountMmk) || 0), 0);
              // Client-side check only (the server enforces it from 090):
              // an older app asked for the line total before the cart discount.
              const excess = request.type === "PARTIAL" && sale
                ? refundRequestExcessMmk(request, sale, saleItems, refunds)
                : 0;
              return (
                <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200/70 bg-white p-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{sale?.receiptNo ?? "Unknown sale"}</div>
                    <div className="text-xs text-slate-500">
                      {request.type} request by {creator?.name ?? "Staff"} • {request.reason}
                      {request.type === "PARTIAL" && ` • ${formatMmk(amount)}`}
                    </div>
                    {excess > 0 && (
                      <div className="mt-1 text-xs text-red-700" role="alert">
                        Asks {formatMmk(excess)} more than the customer paid for these items after discounts. Reject it and ask for a new request.
                      </div>
                    )}
                    {exceptionsOf(request.id).map((a) => (
                      <div key={a.id} className={`mt-1 text-xs ${a.status === "REJECTED" ? "text-red-700" : "text-amber-700"}`}>
                        {a.status === "REJECTED"
                          ? t("fin6", a.kind === "REFUND_ALT_PAYOUT" ? "rejectedAltPayout" : "rejectedPriceAdjust")
                          : t("fin6", a.kind === "REFUND_ALT_PAYOUT" ? "waitingAltPayout" : "waitingPriceAdjust")}
                        {a.status === "REJECTED" && a.decisionReason ? ` — ${a.decisionReason}` : ""}
                      </div>
                    ))}
                    {own && (
                      <div className="mt-1 text-xs text-slate-500">Your own request — another approver must decide it.</div>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone="amber">{request.status ?? "REQUESTED"}</Badge>
                    {!own && (
                      <>
                        <Button
                          variant="secondary"
                          disabled={busyId !== null}
                          onClick={() => setRejecting({ id: request.id, reason: "" })}
                        >
                          Reject
                        </Button>
                        <Button disabled={busyId !== null || excess > 0 || exceptionsOf(request.id).length > 0} onClick={() => void handleApprove(request.id)}>
                          Approve
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {exceptionsAvailable ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-slate-900">{t("fin6", "exceptionTitle")}</div>
              <div className="text-xs text-slate-500">{t("fin6", "exceptionSubtitle")}</div>
            </div>
            <Button variant="secondary" onClick={() => void loadExceptions()} disabled={exceptionBusy !== null}>{t("fin6", "refresh")}</Button>
          </div>
          {exceptions && exceptions.status !== "ok" ? (
            <div className="mt-3 text-xs text-amber-700">{t("fin6", "exceptionsUnavailable", { message: exceptions.message })}</div>
          ) : waitingExceptions.length === 0 ? (
            <div className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
              {t("fin6", "noExceptions")}
            </div>
          ) : (
            <div className="mt-3 space-y-3" data-testid="exception-approvals">
              {waitingExceptions.map((a) => {
                const own = a.requestedBy === currentUserId;
                return (
                  <div key={a.id} className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-slate-200/70 bg-white p-4">
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm font-semibold text-slate-900">{kindLabel(a)}</div>
                      <div className="text-xs text-slate-500">
                        {t("fin6", "requestedBy", { name: userMap[a.requestedBy]?.name ?? a.requestedBy, time: formatDateTime(a.requestedAt) })}
                        {a.reason ? ` • ${a.reason}` : ""}
                      </div>
                      {renderDetails(a)}
                      {own ? (
                        <div className="text-xs text-slate-500">{t("fin6", "ownRequest")}</div>
                      ) : !mayDecide(a) ? (
                        <div className="text-xs text-slate-500">{t("fin6", "notEligible")}</div>
                      ) : null}
                    </div>
                    {!own ? (
                      <div className="flex items-center gap-2">
                        <Button variant="secondary" disabled={exceptionBusy !== null} onClick={() => setRejectingException(a)}>
                          {t("fin6", "reject")}
                        </Button>
                        <Button disabled={exceptionBusy !== null} onClick={() => void decide(a, "APPROVE", null)}>
                          {t("fin6", "approve")}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ) : null}

      <ReasonDialog
        open={rejectingException !== null}
        title={t("fin6", "rejectTitle")}
        description={rejectingException ? `${kindLabel(rejectingException)} — ${t("fin6", "rejectDesc")}` : undefined}
        label={t("fin6", "reasonLabel")}
        confirmLabel={t("fin6", "reject")}
        cancelLabel={t("fin6", "cancel")}
        requiredMessage={t("fin6", "reasonRequired")}
        destructive
        onConfirm={confirmRejectException}
        onClose={() => setRejectingException(null)}
      />

      <Modal
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Reject request"
        description="The requester sees this reason in the audit log."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={!rejecting?.reason.trim() || busyId !== null}
              onClick={() => void handleReject()}
            >
              Reject
            </Button>
          </>
        }
      >
        <Input
          value={rejecting?.reason ?? ""}
          onChange={(event) => setRejecting((prev) => (prev ? { ...prev, reason: event.target.value } : prev))}
          placeholder="Reason (required)"
        />
      </Modal>
    </div>
  );
};
