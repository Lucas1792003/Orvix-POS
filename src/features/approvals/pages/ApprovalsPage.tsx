import { useMemo, useState } from "react";
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
import { formatMmk, getEffectiveShopId } from "../../../lib/utils";
import { refundRequestExcessMmk } from "../../sales/service";

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

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);

  const shopId = getEffectiveShopId(currentUser, currentShopId, shops);
  const pending = refunds.filter(
    (refund) => refund.status === "REQUESTED" && (!shopId || refund.shopId === shopId)
  );
  const saleMap = useMemo(() => Object.fromEntries(sales.map((sale) => [sale.id, sale])), [sales]);
  const userMap = useMemo(() => Object.fromEntries(users.map((user) => [user.id, user])), [users]);

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
                        <Button disabled={busyId !== null || excess > 0} onClick={() => void handleApprove(request.id)}>
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
