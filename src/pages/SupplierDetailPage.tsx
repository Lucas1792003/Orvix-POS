import { ReasonDialog } from "../components/ui/ReasonDialog";
import { useMemo, useState } from "react";
import { useCanViewCost } from "../lib/useCanViewCost";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { useAppStore } from "../stores/appStore";
import { useDataStore } from "../stores/dataStore";
import { useToast } from "../components/ui/Toast";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Tabs } from "../components/ui/Tabs";
import { PurchaseOrderCreateModal } from "../components/purchases/PurchaseOrderCreateModal";
import { PurchaseOrderReceiveModal } from "../components/purchases/PurchaseOrderReceiveModal";
import { SupplierFormModal } from "../components/suppliers/SupplierFormModal";
import { SupplierPaymentModal } from "../components/suppliers/SupplierPaymentModal";
import { LinkProductsModal } from "../components/suppliers/LinkProductsModal";
import { SupplierLumpSumPaymentModal } from "../components/suppliers/SupplierLumpSumPaymentModal";
import {
  buildSupplierFinancialSummary,
  getComputedPaymentStatus,
  getPurchaseOrderBalanceMmk,
  getPurchaseOrderPaidMmk,
  getSupplierPayments,
  getSupplierPurchaseOrders,
} from "../features/suppliers/debt";
import { getPurchaseOrderActionState } from "../features/suppliers/actions";
import { DetailMeta, MoneyLine, SummaryCard } from "../features/suppliers/ui";
import {
  getSupplierPaymentMethodLabel,
  paymentStatusColors,
  poStatusColors,
} from "../features/suppliers/uiConstants";
import { formatDateTime, formatMmk, getEffectiveShopId } from "../lib/utils";
import { getErrorMessage } from "../lib/errors";
import { hasAnyPermission, hasPermission, hasShopPermission } from "../lib/permissions";
import { useTranslation } from "../hooks/useTranslation";
import type { PurchaseOrder } from "../types";

type TabId = "overview" | "products" | "purchases" | "payments";

// Friendly "supplier missing / no access" page. Used both when the id does
// not match any row AND when RLS hides the row from the current user — we
// can't tell the two apart from the client, so the copy covers both cases.
const SupplierNotFound = () => {
  const { t } = useTranslation();
  return (
    <Card className="text-center">
      <h1 className="text-xl font-semibold text-slate-900">{t("suppliers", "notFoundTitle")}</h1>
      <p className="mt-2 text-sm text-slate-500">{t("suppliers", "notFoundBody")}</p>
      <div className="mt-5">
        <Link to="/app/suppliers">
          <Button>{t("suppliers", "backToSuppliers")}</Button>
        </Link>
      </div>
    </Card>
  );
};

export const SupplierDetailPage = () => {
  const canViewCost = useCanViewCost();
  const { supplierId } = useParams<{ supplierId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useTranslation();

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "overview", label: t("suppliers", "detailTabOverview") },
    { id: "products", label: t("suppliers", "detailTabProducts") },
    { id: "purchases", label: t("suppliers", "detailTabPurchases") },
    { id: "payments", label: t("suppliers", "detailTabPayments") },
  ];

  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((u) => u.id === currentUserId));
  const { currentShopId } = useAppStore();
  const shops = useDataStore((state) => state.shops);
  const suppliers = useDataStore((state) => state.suppliers);
  const purchaseOrders = useDataStore((state) => state.purchaseOrders);
  const purchaseOrderItems = useDataStore((state) => state.purchaseOrderItems);
  const supplierPayments = useDataStore((state) => state.supplierPayments);
  const products = useDataStore((state) => state.products);
  const supplierProducts = useDataStore((state) => state.supplierProducts);
  const users = useDataStore((state) => state.users);
  const approvePurchaseOrder = useDataStore((state) => state.approvePurchaseOrder);
  const cancelPurchaseOrder = useDataStore((state) => state.cancelPurchaseOrder);
  const removeSupplierProduct = useDataStore((state) => state.removeSupplierProduct);
  const voidSupplierPayment = useDataStore((state) => state.voidSupplierPayment);

  const [tab, setTab] = useState<TabId>("overview");
  const [expandedPoId, setExpandedPoId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [linkProductsOpen, setLinkProductsOpen] = useState(false);
  const [lumpSumOpen, setLumpSumOpen] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [voidingPaymentId, setVoidingPaymentId] = useState<string | null>(null);
  const [voidDialogPaymentId, setVoidDialogPaymentId] = useState<string | null>(null);
  const [createPoOpen, setCreatePoOpen] = useState(false);
  const [receivePoId, setReceivePoId] = useState<string | null>(null);
  const [paymentPoId, setPaymentPoId] = useState<string | null>(null);
  const [busyPoId, setBusyPoId] = useState<string | null>(null);

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;
  const isAdmin = currentUser?.role === "ADMIN";
  const shopId = getEffectiveShopId(currentUser, currentShopId, shops);
  const canUpdateSupplier = hasPermission(currentUser, "supplier:update");
  const canViewDebt = hasAnyPermission(currentUser, ["supplier:debt_view", "purchase:view"]);
  // Linking products writes supplier_products, which RLS gates on product
  // create/update — so only show the controls to users who can actually save.
  const canManageLinks = hasAnyPermission(currentUser, ["product:update", "product:create"]);
  // Voiding mirrors recording: shop-scoped supplier:payment_create (ADMIN any).
  const canVoidPayment = (shopOfPayment: string) =>
    isAdmin || hasShopPermission(currentUser, "supplier:payment_create", shopOfPayment);
  const canRaisePoForShop = hasShopPermission(currentUser, "purchase:create", shopId);

  // Mirror the SuppliersPage scoping: ADMIN sees all, others only see records
  // for their own shop. Server-side RLS still enforces this — the filter just
  // keeps our summaries consistent for managers viewing a supplier that has
  // POs across multiple shops.
  const visiblePurchaseOrders = useMemo(
    () => purchaseOrders.filter((po) => isAdmin || po.shopId === shopId),
    [purchaseOrders, isAdmin, shopId]
  );
  const visibleSupplierPayments = useMemo(
    () => supplierPayments.filter((payment) => isAdmin || payment.shopId === shopId),
    [supplierPayments, isAdmin, shopId]
  );

  const supplierOrders = useMemo(
    () => (supplier ? getSupplierPurchaseOrders(supplier.id, visiblePurchaseOrders) : []),
    [supplier, visiblePurchaseOrders]
  );
  const supplierPaymentsList = useMemo(
    () => (supplier ? getSupplierPayments(supplier.id, visibleSupplierPayments) : []),
    [supplier, visibleSupplierPayments]
  );
  const summary = useMemo(
    () => (supplier ? buildSupplierFinancialSummary(supplier.id, visiblePurchaseOrders) : null),
    [supplier, visiblePurchaseOrders]
  );

  // Outstanding POs for the lump-sum "Pay supplier" flow — scoped to the
  // effective shop (payments are per shop), RECEIVED with a balance, oldest first.
  const lumpSumPos = useMemo(
    () =>
      supplier && shopId
        ? purchaseOrders.filter(
            (po) =>
              po.supplierId === supplier.id &&
              po.shopId === shopId &&
              po.status === "RECEIVED" &&
              getPurchaseOrderBalanceMmk(po) > 0
          )
        : [],
    [supplier, shopId, purchaseOrders]
  );
  const canPayLumpSum =
    Boolean(shopId) &&
    (isAdmin || hasShopPermission(currentUser, "supplier:payment_create", shopId)) &&
    lumpSumPos.length > 0;

  // Products this supplier can supply (many-to-many link, managed from the
  // product form). Sorted by name; inactive products shown with a badge.
  const linkedProducts = useMemo(() => {
    if (!supplier) return [];
    const linkedIds = new Set(
      supplierProducts.filter((link) => link.supplierId === supplier.id).map((link) => link.productId)
    );
    return products
      .filter((product) => linkedIds.has(product.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [supplier, supplierProducts, products]);

  const lastPurchaseDate = useMemo(() => {
    if (!supplier) return null;
    // Use createdAt as a proxy for "last purchase date" — it's the only
    // timestamp guaranteed on every PO regardless of approval/receiving state.
    const dates = supplierOrders
      .map((po) => po.createdAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    return dates[0] ?? null;
  }, [supplier, supplierOrders]);

  if (!supplier) return <SupplierNotFound />;

  const paymentPo = paymentPoId ? supplierOrders.find((po) => po.id === paymentPoId) ?? null : null;
  const linkedProductIds = new Set(linkedProducts.map((product) => product.id));

  // The reason comes from a ReasonDialog, never prompt(): Electron has no prompt(), so voiding silently did nothing on the
  // desktop app (ORV-013; found in Step 6).
  const handleVoidPayment = (paymentId: string) => {
    if (voidingPaymentId || voidDialogPaymentId) return;
    setVoidDialogPaymentId(paymentId);
  };
  const confirmVoidPayment = async (reason: string) => {
    const paymentId = voidDialogPaymentId;
    if (!paymentId || voidingPaymentId) return;
    setVoidingPaymentId(paymentId);
    try {
      await voidSupplierPayment({ paymentId, reason: reason.trim() });
      toast({ variant: "success", title: t("suppliers", "paymentVoided") });
    } catch (error) {
      toast({
        variant: "error",
        title: t("suppliers", "couldNotVoid"),
        description: getErrorMessage(error, t("suppliers", "tryAgain")),
      });
      throw error;   // keeps the reason dialog open with the typed reason
    } finally {
      setVoidingPaymentId(null);
    }
  };

  const handleUnlinkProduct = async (productId: string) => {
    if (unlinkingId) return;
    setUnlinkingId(productId);
    try {
      await removeSupplierProduct(supplier.id, productId);
      toast({ variant: "success", title: t("suppliers", "productUnlinked") });
    } catch (error) {
      toast({
        variant: "error",
        title: t("suppliers", "couldNotUnlink"),
        description: getErrorMessage(error, t("suppliers", "tryAgain")),
      });
    } finally {
      setUnlinkingId(null);
    }
  };

  const handleApprovePo = async (po: PurchaseOrder) => {
    if (!currentUserId || busyPoId) return;
    setBusyPoId(po.id);
    try {
      await approvePurchaseOrder({ purchaseOrderId: po.id, approverId: currentUserId });
      toast({ variant: "success", title: t("suppliers", "approvedPo", { orderNo: po.orderNo }) });
    } catch (error) {
      toast({
        variant: "error",
        title: t("purchases", "approvalFailed"),
        description: getErrorMessage(error, t("purchases", "approvalFailedDesc")),
      });
    } finally {
      setBusyPoId(null);
    }
  };

  const handleCancelPo = async (po: PurchaseOrder) => {
    if (!currentUserId || busyPoId) return;
    if (!confirm(t("suppliers", "confirmCancelPo", { orderNo: po.orderNo }))) return;
    setBusyPoId(po.id);
    try {
      await cancelPurchaseOrder({ purchaseOrderId: po.id, actorId: currentUserId });
      toast({ variant: "success", title: t("suppliers", "canceledPo", { orderNo: po.orderNo }) });
    } catch (error) {
      toast({
        variant: "error",
        title: t("purchases", "cancelFailed"),
        description: getErrorMessage(error, t("purchases", "cancelFailedDesc")),
      });
    } finally {
      setBusyPoId(null);
    }
  };

  // ---- Header --------------------------------------------------------------

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      {canUpdateSupplier && (
        <Button variant="secondary" onClick={() => setEditOpen(true)}>
          {t("suppliers", "editSupplier")}
        </Button>
      )}
      {canPayLumpSum && (
        <Button variant="secondary" onClick={() => setLumpSumOpen(true)}>{t("suppliers", "paySupplierTitle")}</Button>
      )}
      {canRaisePoForShop && supplier.isActive && (
        <Button onClick={() => setCreatePoOpen(true)}>{t("suppliers", "createPo")}</Button>
      )}
    </div>
  );

  // ---- Overview tab --------------------------------------------------------

  const overviewSection = (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200/70 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">{t("suppliers", "profileTitle")}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{t("suppliers", "profileSubtitle")}</p>
          </div>
          <Badge color={supplier.isActive ? "green" : "gray"}>
            {supplier.isActive ? t("common", "active") : t("common", "inactive")}
          </Badge>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DetailMeta label={t("suppliers", "contact")} value={supplier.contactPerson ?? "-"} />
          <DetailMeta label={t("suppliers", "phone")} value={supplier.phone ?? "-"} />
          <DetailMeta label={t("suppliers", "email")} value={supplier.email ?? "-"} />
          <DetailMeta label={t("suppliers", "address")} value={supplier.address ?? "-"} />
          <DetailMeta label={t("suppliers", "code")} value={<span className="font-mono">{supplier.code}</span>} />
          <DetailMeta label={t("suppliers", "addedLabel")} value={formatDateTime(supplier.createdAt)} />
        </div>
        {supplier.notes && (
          <div className="mt-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
            {supplier.notes}
          </div>
        )}
      </section>
    </div>
  );

  // ---- Purchase Orders tab -------------------------------------------------

  const purchasesSection =
    supplierOrders.length === 0 ? (
      <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        {t("suppliers", "noPurchaseRecords")}
        {canRaisePoForShop && supplier.isActive && (
          <div className="mt-4">
            <Button onClick={() => setCreatePoOpen(true)}>{t("suppliers", "createPo")}</Button>
          </div>
        )}
      </div>
    ) : (
      <div className="space-y-3">
        {supplierOrders.map((po) => {
          const balance = getPurchaseOrderBalanceMmk(po);
          const paymentStatus = getComputedPaymentStatus(po);
          const receivedByUser = po.receivedBy ? users.find((u) => u.id === po.receivedBy) : undefined;
          const poItems = purchaseOrderItems.filter((item) => item.purchaseOrderId === po.id);
          const hasPartialReceiving =
            po.status === "RECEIVED" && poItems.some((item) => (item.receivedQty ?? 0) < item.orderedQty);
          const receivedStatus =
            po.status === "RECEIVED"
              ? {
                  label: hasPartialReceiving
                    ? t("suppliers", "partiallyReceived")
                    : t("purchases", "received"),
                  color: hasPartialReceiving ? "yellow" : "green",
                }
              : { label: t("suppliers", "notReceived"), color: "gray" };
          const actionState = getPurchaseOrderActionState(po, currentUser);
          const isExpanded = expandedPoId === po.id;
          const isBusy = busyPoId === po.id;

          return (
            <article
              key={po.id}
              className="rounded-3xl border border-slate-200/70 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-base font-semibold text-slate-900">{po.orderNo}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {shops.find((shop) => shop.id === po.shopId)?.name ?? po.shopId} ·{" "}
                    {t("purchases", "created")} {formatDateTime(po.createdAt)}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Badge color={poStatusColors[po.status]}>{po.status}</Badge>
                  <Badge color={receivedStatus.color}>{receivedStatus.label}</Badge>
                  <Badge color={paymentStatusColors[paymentStatus]}>{paymentStatus}</Badge>
                  {actionState.hint && <Badge color="amber">{actionState.hint}</Badge>}
                </div>
              </div>

              <div className="mt-4 grid gap-3 rounded-2xl bg-slate-50/80 p-3 sm:grid-cols-3">
                <MoneyLine label={t("purchases", "total")} value={po.totalMmk} />
                <MoneyLine label={t("suppliers", "paid")} value={getPurchaseOrderPaidMmk(po)} tone="green" />
                <MoneyLine label={t("suppliers", "balance")} value={balance} tone={balance > 0 ? "red" : "slate"} />
              </div>

              <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                <div>
                  <span className="font-medium text-slate-500">{t("suppliers", "receivedDate")}: </span>
                  {po.receivedAt ? formatDateTime(po.receivedAt) : t("suppliers", "notReceived")}
                </div>
                <div>
                  <span className="font-medium text-slate-500">{t("suppliers", "receivedByLabel")}: </span>
                  {receivedByUser?.name ?? "-"}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setExpandedPoId(isExpanded ? null : po.id)}
                >
                  {isExpanded ? t("suppliers", "hideDetails") : t("suppliers", "viewDetails")}
                </Button>
                <div className="flex flex-wrap items-center gap-2">
                  {actionState.nextAction === "approve" && actionState.canActor && (
                    <Button size="sm" disabled={isBusy} onClick={() => handleApprovePo(po)}>
                      {isBusy ? t("suppliers", "approving") : t("purchases", "approve")}
                    </Button>
                  )}
                  {actionState.nextAction === "receive" && actionState.canActor && (
                    <Button size="sm" onClick={() => setReceivePoId(po.id)}>
                      {t("purchases", "receive")}
                    </Button>
                  )}
                  {actionState.nextAction === "pay" && actionState.canActor && (
                    <Button size="sm" onClick={() => setPaymentPoId(po.id)}>
                      {t("suppliers", "recordPayment")}
                    </Button>
                  )}
                  {actionState.canCancel && (
                    <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => handleCancelPo(po)}>
                      {t("suppliers", "cancelPo")}
                    </Button>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="mt-5 space-y-4 border-t border-slate-200/70 pt-4">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <DetailMeta label={t("suppliers", "supplierInvoice")} value={po.supplierInvoiceNo ?? "-"} />
                    <DetailMeta label={t("suppliers", "deliveryNote")} value={po.deliveryNoteNo ?? "-"} />
                    <DetailMeta
                      label={t("suppliers", "approvedAtLabel")}
                      value={po.approvedAt ? formatDateTime(po.approvedAt) : "-"}
                    />
                    <DetailMeta
                      label={t("suppliers", "approvedByLabel")}
                      value={
                        po.approvedBy
                          ? users.find((u) => u.id === po.approvedBy)?.name ?? po.approvedBy
                          : "-"
                      }
                    />
                  </div>

                  {po.status === "RECEIVED" && (
                    <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
                      {t("suppliers", "receivedByLine", {
                        name: receivedByUser?.name ?? po.receivedBy ?? t("suppliers", "unknownUser"),
                        when: po.receivedAt ? t("suppliers", "onDate", { date: formatDateTime(po.receivedAt) }) : "",
                      })}
                    </div>
                  )}

                  {poItems.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm text-slate-500">
                      {t("suppliers", "noLineItems")}
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-200/70">
                      <table className="w-full min-w-[640px] text-sm">
                        <thead>
                          <tr className="border-b text-left text-slate-500">
                            <th className="pb-2 font-medium">{t("purchases", "product")}</th>
                            <th className="pb-2 text-right font-medium">{t("purchases", "ordered")}</th>
                            <th className="pb-2 text-right font-medium">{t("purchases", "receivedCol")}</th>
                            <th className="pb-2 text-right font-medium">{t("purchases", "unitCost")}</th>
                            <th className="pb-2 text-right font-medium">{t("suppliers", "lineTotal")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {poItems.map((item) => {
                            const product = products.find((p) => p.id === item.productId);
                            const receivedQty = item.receivedQty ?? 0;
                            return (
                              <tr key={item.id} className="border-b last:border-0">
                                <td className="py-2">{product?.name ?? item.productId}</td>
                                <td className="py-2 text-right tabular-nums">{item.orderedQty}</td>
                                <td className="py-2 text-right tabular-nums">
                                  {po.status === "RECEIVED" ? receivedQty : "-"}
                                </td>
                                <td className="py-2 text-right tabular-nums">
                                  {formatMmk(item.unitCostMmk)}
                                </td>
                                <td className="py-2 text-right tabular-nums">
                                  {formatMmk(item.lineTotalMmk)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    );

  // ---- Products tab --------------------------------------------------------

  const productsSection = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {t("suppliers", "productsLinkedCount", { n: linkedProducts.length })}
        </p>
        {canManageLinks && (
          <Button size="sm" onClick={() => setLinkProductsOpen(true)}>
            <span className="material-symbols-rounded mr-1 text-sm">add</span>
            {t("suppliers", "addProductsTitle")}
          </Button>
        )}
      </div>

      {linkedProducts.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          {t("suppliers", "noProductsLinked")}
          {canManageLinks
            ? t("suppliers", "noProductsLinkedManage")
            : t("suppliers", "noProductsLinkedReadonly")}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200/70 bg-white shadow-sm">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="px-4 py-3 font-medium">{t("purchases", "product")}</th>
                <th className="px-4 py-3 font-medium">{t("suppliers", "sku")}</th>
                <th className="px-4 py-3 font-medium">{t("common", "category")}</th>
                <th className="px-4 py-3 text-right font-medium">{t("suppliers", "cost")}</th>
                <th className="px-4 py-3 text-right font-medium">{t("common", "price")}</th>
                <th className="px-4 py-3 font-medium">{t("common", "status")}</th>
                {canManageLinks && <th className="px-4 py-3 text-right font-medium">{t("common", "actions")}</th>}
              </tr>
            </thead>
            <tbody>
              {linkedProducts.map((product) => (
                <tr key={product.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-medium text-slate-900">{product.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{product.sku ?? "-"}</td>
                  <td className="px-4 py-3 text-slate-600">{product.category}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                    {canViewCost && product.costMmk != null ? formatMmk(product.costMmk) : "-"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-900">
                    {formatMmk(product.priceMmk)}
                  </td>
                  <td className="px-4 py-3">
                    <Badge color={product.isActive ? "green" : "gray"}>
                      {product.isActive ? t("common", "active") : t("common", "inactive")}
                    </Badge>
                  </td>
                  {canManageLinks && (
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={unlinkingId === product.id}
                        onClick={() => handleUnlinkProduct(product.id)}
                      >
                        {unlinkingId === product.id ? t("suppliers", "removing") : t("suppliers", "remove")}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ReasonDialog
        key={voidDialogPaymentId ? `void:${voidDialogPaymentId}` : "closed"}
        open={voidDialogPaymentId !== null}
        title={t("suppliers", "voidAction")}
        label={t("suppliers", "voidReasonPrompt")}
        confirmLabel={t("suppliers", "voidAction")}
        cancelLabel={t("common", "back")}
        requiredMessage={t("transfers", "reasonRequired")}
        destructive
        onConfirm={confirmVoidPayment}
        onClose={() => setVoidDialogPaymentId(null)}
      />
    </div>
  );

  // ---- Payments tab --------------------------------------------------------

  const paymentsSection =
    supplierPaymentsList.length === 0 ? (
      <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        {t("suppliers", "noPayments")}
      </div>
    ) : (
      <div className="overflow-x-auto rounded-2xl border border-slate-200/70 bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b text-left text-slate-500">
              <th className="px-4 py-3 font-medium">{t("common", "date")}</th>
              <th className="px-4 py-3 font-medium">{t("purchases", "poNo")}</th>
              <th className="px-4 py-3 text-right font-medium">{t("common", "amount")}</th>
              <th className="px-4 py-3 font-medium">{t("suppliers", "method")}</th>
              <th className="px-4 py-3 font-medium">{t("suppliers", "reference")}</th>
              <th className="px-4 py-3 font-medium">{t("suppliers", "notes")}</th>
              <th className="px-4 py-3 font-medium">{t("suppliers", "recordedBy")}</th>
              <th className="px-4 py-3 text-right font-medium">{t("common", "status")}</th>
            </tr>
          </thead>
          <tbody>
            {supplierPaymentsList.map((payment) => {
              const po = visiblePurchaseOrders.find((order) => order.id === payment.purchaseOrderId);
              const createdByUser = users.find((u) => u.id === payment.createdBy);
              const isVoided = Boolean(payment.voidedAt);
              return (
                <tr key={payment.id} className="border-b last:border-0">
                  <td className="px-4 py-3 text-slate-500">{formatDateTime(payment.paidAt)}</td>
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span>{po?.orderNo ?? payment.purchaseOrderId}</span>
                      {payment.pendingSync && <Badge tone="amber">Pending sync</Badge>}
                    </div>
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-bold tabular-nums ${
                      isVoided ? "text-slate-400 line-through" : "text-emerald-700"
                    }`}
                  >
                    {formatMmk(payment.amountMmk)}
                  </td>
                  <td className="px-4 py-3">{getSupplierPaymentMethodLabel(payment.paymentMethod)}</td>
                  <td className="px-4 py-3">{payment.referenceNo ?? "-"}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {isVoided ? payment.voidReason ?? t("suppliers", "voided") : payment.notes ?? "-"}
                  </td>
                  <td className="px-4 py-3">{createdByUser?.name ?? payment.createdBy}</td>
                  <td className="px-4 py-3 text-right">
                    {isVoided ? (
                      <Badge color="gray">{t("suppliers", "voided")}</Badge>
                    ) : canVoidPayment(payment.shopId) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={voidingPaymentId === payment.id}
                        onClick={() => handleVoidPayment(payment.id)}
                      >
                        {voidingPaymentId === payment.id ? t("suppliers", "voiding") : t("suppliers", "voidAction")}
                      </Button>
                    ) : (
                      <span className="text-slate-300">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className="space-y-6">
      <Card>
        <PageHeader
          title={supplier.name}
          crumbs={[{ label: t("suppliers", "title"), href: "/app/suppliers" }, { label: supplier.name }]}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => navigate("/app/suppliers")}>
                ← {t("common", "back")}
              </Button>
              {headerActions}
            </div>
          }
        />

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <Badge color={supplier.isActive ? "green" : "gray"}>
            {supplier.isActive ? t("common", "active") : t("common", "inactive")}
          </Badge>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono font-semibold text-slate-700">
            {supplier.code}
          </span>
          {supplier.contactPerson && <span>{supplier.contactPerson}</span>}
          {supplier.phone && <span>{supplier.phone}</span>}
        </div>

        {summary && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
            <SummaryCard
              label={t("suppliers", "outstandingDebt")}
              value={canViewDebt ? formatMmk(summary.outstandingDebtMmk) : "—"}
              tone={summary.outstandingDebtMmk > 0 ? "red" : "green"}
            />
            <SummaryCard
              label={t("suppliers", "receivedPurchases")}
              value={canViewDebt ? formatMmk(summary.totalReceivedPurchasesMmk) : "—"}
            />
            <SummaryCard
              label={t("suppliers", "paid")}
              value={canViewDebt ? formatMmk(summary.totalPaidMmk) : "—"}
              tone="green"
            />
            <SummaryCard
              label={t("suppliers", "unpaidPartialPos")}
              value={summary.unpaidPoCount + summary.partialPoCount}
              tone={summary.unpaidPoCount + summary.partialPoCount > 0 ? "amber" : "slate"}
              badge={
                <Badge color={summary.partialPoCount > 0 ? "yellow" : "gray"}>
                  {t("suppliers", "partialCount", { n: summary.partialPoCount })}
                </Badge>
              }
            />
            <SummaryCard
              label={t("suppliers", "lastPurchase")}
              value={lastPurchaseDate ? formatDateTime(lastPurchaseDate) : "—"}
            />
          </div>
        )}

        <div className="mt-6">
          <Tabs
            tabs={tabs}
            active={tab}
            onChange={(id) => setTab(id as TabId)}
          />
        </div>

        <div className="mt-5">
          {tab === "overview" && overviewSection}
          {tab === "products" && productsSection}
          {tab === "purchases" && purchasesSection}
          {tab === "payments" && paymentsSection}
        </div>
      </Card>

      <SupplierFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        editing={supplier}
        suppliers={suppliers}
      />

      <PurchaseOrderCreateModal
        open={createPoOpen}
        onClose={() => setCreatePoOpen(false)}
        shopId={shopId}
        currentUserId={currentUserId}
        defaultSupplierId={supplier.id}
        suppliers={suppliers}
        products={products}
        supplierProducts={supplierProducts}
        onCreated={() => setTab("purchases")}
      />

      <PurchaseOrderReceiveModal
        purchaseOrderId={receivePoId}
        onClose={() => setReceivePoId(null)}
        currentUserId={currentUserId}
      />

      <SupplierPaymentModal
        purchaseOrder={paymentPo}
        onClose={() => setPaymentPoId(null)}
      />

      <LinkProductsModal
        open={linkProductsOpen}
        onClose={() => setLinkProductsOpen(false)}
        supplierId={supplier.id}
        supplierName={supplier.name}
        products={products}
        linkedProductIds={linkedProductIds}
      />

      <SupplierLumpSumPaymentModal
        open={lumpSumOpen}
        onClose={() => setLumpSumOpen(false)}
        supplier={supplier}
        shopId={shopId}
        outstandingPos={lumpSumPos}
      />
    </div>
  );
};
