import { useMemo, useState } from "react";
import { useAuthStore } from "../stores/authStore";
import { useAppStore } from "../stores/appStore";
import { useDataStore } from "../stores/dataStore";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Tabs } from "../components/ui/Tabs";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { SearchInput } from "../components/forms/SearchInput";
import { TransferReceiveModal } from "../components/transfers/TransferReceiveModal";
import { useToast } from "../components/ui/Toast";
import { useTranslation } from "../hooks/useTranslation";
import { formatDateTime, getEffectiveShopId } from "../lib/utils";
import { reportError } from "../lib/errors";
import { mayAlreadyBeRecorded, outcomeToast } from "../lib/outcomeToast";
import { getActiveProductUnits, getDefaultProductUnit } from "../features/catalog/productUnits";
import { convertToBaseQuantity, formatStockQuantity } from "../features/inventory/stockDisplay";
import {
  getMaxTransferUnitQuantity,
  getTransferLineBaseQuantity,
  getTransferProductBaseTotal,
  transferProductExceedsStock,
  type UnitTransferLine,
} from "../features/transfers/unitTransfer";
import type { ProductUnit, StockTransferItem, TransferStatus } from "../types";

const statusColors: Record<TransferStatus, "gray" | "yellow" | "green" | "red" | "blue" | "indigo"> = {
  PENDING: "yellow",
  APPROVED: "blue",
  IN_TRANSIT: "indigo",
  COMPLETED: "green",
  CANCELED: "gray",
  REJECTED: "red",
};


interface TransferFormItem extends UnitTransferLine {
  lineId: string;
  productUnitId: string;
  selectedUnitQuantity: number;
}

const makeTransferLineId = () =>
  `transfer-line-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const formatBaseQty = (qty: number | undefined, unitName: string | undefined) =>
  qty === undefined ? "-" : `${qty} ${unitName || "unit"}`;

const formatEnteredAs = (item: StockTransferItem, fallbackUnit?: ProductUnit) => {
  const unitName = item.unitNameSnapshot ?? fallbackUnit?.name;
  const selectedQty = item.selectedUnitQuantity;
  if (unitName && selectedQty !== undefined) return `${selectedQty} ${unitName}`;
  return null;
};

export const TransfersPage = () => {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((u) => u.id === currentUserId));
  const { currentShopId } = useAppStore();
  const shops = useDataStore((state) => state.shops);
  const products = useDataStore((state) => state.products);
  const productUnits = useDataStore((state) => state.productUnits);
  const inventory = useDataStore((state) => state.inventory);
  const transfers = useDataStore((state) => state.stockTransfers);
  const transferItems = useDataStore((state) => state.stockTransferItems);
  const users = useDataStore((state) => state.users);

  const createTransfer = useDataStore((state) => state.createTransfer);
  const approveTransfer = useDataStore((state) => state.approveTransfer);
  const rejectTransfer = useDataStore((state) => state.rejectTransfer);
  const dispatchTransfer = useDataStore((state) => state.dispatchTransfer);
  const cancelTransfer = useDataStore((state) => state.cancelTransfer);

  const [activeTab, setActiveTab] = useState("all");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState<string | null>(null);
  const [receiveTransferId, setReceiveTransferId] = useState<string | null>(null);

  // Create transfer form state
  const [newTransfer, setNewTransfer] = useState({
    toShopId: "",
    items: [] as TransferFormItem[],
    notes: "",
  });

  const shopId = getEffectiveShopId(currentUser, currentShopId, shops);
  const isAdmin = currentUser?.role === "ADMIN";
  const isManager = currentUser?.role === "MANAGER" || isAdmin;
  const { t } = useTranslation();
  const toast = useToast();
  const statusLabels: Record<TransferStatus, string> = {
    PENDING: t("transfers", "pending"),
    APPROVED: t("transfers", "approved"),
    IN_TRANSIT: t("transfers", "inTransit"),
    COMPLETED: t("transfers", "completed"),
    CANCELED: t("transfers", "canceled"),
    REJECTED: t("transfers", "rejected"),
  };

  // Filter transfers based on tab and filters
  const filteredTransfers = useMemo(() => {
    return transfers
      .filter((t) => {
        // Tab filter
        if (activeTab === "outgoing") return t.fromShopId === shopId;
        if (activeTab === "incoming") return t.toShopId === shopId;
        if (activeTab === "pending") return t.fromShopId === shopId && t.status === "PENDING";
        // "all" tab - show transfers involving current shop
        return t.fromShopId === shopId || t.toShopId === shopId;
      })
      .filter((t) => statusFilter === "all" || t.status === statusFilter)
      .filter((t) => t.transferNo.toLowerCase().includes(search.toLowerCase()));
  }, [transfers, activeTab, statusFilter, search, shopId]);

  const pendingForApproval = transfers.filter(
    (t) => t.fromShopId === shopId && t.status === "PENDING"
  );

  const getAvailableBase = (productId: string) =>
    inventory.find((i) => i.shopId === shopId && i.productId === productId)?.qtyBaseUnits ?? 0;

  const getTransferUnits = (productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (!product) return [];
    const activeUnits = getActiveProductUnits(productId, productUnits);
    return activeUnits.length > 0 ? activeUnits : [getDefaultProductUnit(product, productUnits)];
  };

  const getFirstAvailableUnit = (productId: string) => {
    const used = new Set(
      newTransfer.items
        .filter((item) => item.productId === productId)
        .map((item) => item.productUnitId)
    );
    const units = getTransferUnits(productId);
    const preferred = units.find((unit) => unit.isDefault && !used.has(unit.id));
    return preferred ?? units.find((unit) => !used.has(unit.id)) ?? null;
  };

  const getLineUnit = (item: TransferFormItem) =>
    getTransferUnits(item.productId).find((unit) => unit.id === item.productUnitId);

  const canAddProductToTransfer = (productId: string) => {
    const availableBase = getAvailableBase(productId);
    const usedBase = getTransferProductBaseTotal(newTransfer.items, productId, productUnits);
    const unit = getFirstAvailableUnit(productId);
    return Boolean(unit && availableBase - usedBase >= unit.baseQuantity);
  };

  const hasInvalidTransferItems = newTransfer.items.some((item) => {
    const availableBase = getAvailableBase(item.productId);
    const lineUnit = getLineUnit(item);
    return (
      !lineUnit ||
      item.selectedUnitQuantity <= 0 ||
      transferProductExceedsStock(newTransfer.items, item.productId, productUnits, availableBase)
    );
  });

  const handleCreateTransfer = async () => {
    if (
      !currentUserId ||
      !newTransfer.toShopId ||
      newTransfer.items.length === 0 ||
      hasInvalidTransferItems
    ) return;
    try {
      await createTransfer({
        fromShopId: shopId,
        toShopId: newTransfer.toShopId,
        items: newTransfer.items.map((item) => ({
          productId: item.productId,
          productUnitId: item.productUnitId,
          selectedUnitQuantity: item.selectedUnitQuantity,
        })),
        notes: newTransfer.notes,
        createdBy: currentUserId,
      });
      setShowCreateModal(false);
      setNewTransfer({ toShopId: "", items: [], notes: "" });
    } catch (error) {
      if (mayAlreadyBeRecorded(error)) {
        // Unknown outcome: "pending confirmation", and the form closes so
        // the same transfer is not entered again.
        toast(outcomeToast(error, t, t("transfers", "failCreate"), t("transfers", "failCreate")));
        setShowCreateModal(false);
        setNewTransfer({ toShopId: "", items: [], notes: "" });
        return;
      }
      const toastItem = outcomeToast(error, t, t("transfers", "failCreate"), t("transfers", "failCreate"));
      toast(toastItem.variant === "error"
        ? { ...toastItem, description: reportError("TransfersPage.create", error, t("transfers", "failCreate")) }
        : toastItem);
    }
  };

  const handleApprove = async (transferId: string) => {
    if (!currentUserId) return;
    try {
      await approveTransfer({ transferId, approverId: currentUserId });
    } catch (error) {
      toast({
        variant: "error",
        title: t("transfers", "failApprove"),
        description: reportError("TransfersPage.approve", error, t("transfers", "failApprove")),
      });
    }
  };

  const handleReject = async (transferId: string) => {
    if (!currentUserId) return;
    const reason = prompt("Enter rejection reason:");
    if (!reason) return;
    try {
      await rejectTransfer({ transferId, actorId: currentUserId, reason });
    } catch (error) {
      toast({
        variant: "error",
        title: t("transfers", "failReject"),
        description: reportError("TransfersPage.reject", error, t("transfers", "failReject")),
      });
    }
  };

  const handleDispatch = async (transferId: string) => {
    if (!currentUserId) return;
    try {
      await dispatchTransfer({ transferId, actorId: currentUserId });
    } catch (error) {
      toast({
        variant: "error",
        title: t("transfers", "failDispatch"),
        description: reportError("TransfersPage.dispatch", error, t("transfers", "failDispatch")),
      });
    }
  };

  const handleCancel = async (transferId: string) => {
    if (!currentUserId) return;
    const reason = prompt("Enter cancellation reason:");
    if (!reason) return;
    try {
      await cancelTransfer({ transferId, actorId: currentUserId, reason });
    } catch (error) {
      toast({
        variant: "error",
        title: t("transfers", "failCancel"),
        description: reportError("TransfersPage.cancel", error, t("transfers", "failCancel")),
      });
    }
  };

  const addItemToTransfer = (productId: string) => {
    const unit = getFirstAvailableUnit(productId);
    const availableBase = getAvailableBase(productId);
    const alreadyRequestedBase = getTransferProductBaseTotal(newTransfer.items, productId, productUnits);
    if (!unit || availableBase - alreadyRequestedBase < unit.baseQuantity) {
      alert(t("transfers", "noStock"));
      return;
    }
    setNewTransfer((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        {
          lineId: makeTransferLineId(),
          productId,
          productUnitId: unit.id,
          selectedUnitQuantity: 1,
        },
      ],
    }));
  };

  const updateItemUnit = (lineId: string, unitId: string) => {
    setNewTransfer((prev) => ({
      ...prev,
      items: prev.items.map((i) =>
        i.lineId === lineId
          ? (() => {
              const unit = getTransferUnits(i.productId).find((u) => u.id === unitId);
              const previousBase = getTransferLineBaseQuantity(i, productUnits);
              const nextQty = Math.max(
                1,
                Math.floor(previousBase / Math.max(1, unit?.baseQuantity ?? 1))
              );
              const nextLine = { ...i, productUnitId: unitId, selectedUnitQuantity: nextQty };
              const maxQty = getMaxTransferUnitQuantity(
                prev.items,
                nextLine,
                productUnits,
                getAvailableBase(i.productId)
              );
              return { ...nextLine, selectedUnitQuantity: Math.min(nextQty, Math.max(1, maxQty)) };
            })()
          : i
      ),
    }));
  };

  const updateItemQty = (lineId: string, qty: number) => {
    setNewTransfer((prev) => ({
      ...prev,
      items: prev.items.map((i) => {
        if (i.lineId !== lineId) return i;
        const maxQty = getMaxTransferUnitQuantity(
          prev.items,
          i,
          productUnits,
          getAvailableBase(i.productId)
        );
        return { ...i, selectedUnitQuantity: Math.min(Math.max(1, qty), Math.max(1, maxQty)) };
      }),
    }));
  };

  const removeItemFromTransfer = (lineId: string) => {
    setNewTransfer((prev) => ({
      ...prev,
      items: prev.items.filter((i) => i.lineId !== lineId),
    }));
  };

  const selectedTransfer = showDetailModal ? transfers.find((t) => t.id === showDetailModal) : null;
  const selectedTransferItems = showDetailModal
    ? transferItems.filter((i) => i.transferId === showDetailModal)
    : [];

  return (
    <Card>
      <PageHeader
        title={t("transfers", "title")}
        subtitle={t("transfers", "subtitle")}
        actions={
          isManager && (
            <Button onClick={() => setShowCreateModal(true)}>{t("transfers", "newTransfer")}</Button>
          )
        }
      />

      {pendingForApproval.length > 0 && isManager && (
        <div className="mt-4 rounded-lg bg-yellow-50 border border-yellow-200 p-4">
          <p className="text-sm font-medium text-yellow-800">
            {pendingForApproval.length} transfer(s) pending your approval
          </p>
        </div>
      )}

      <div className="mt-6">
        <Tabs
          tabs={[
            { id: "all", label: t("transfers", "tabAll") },
            { id: "outgoing", label: t("transfers", "tabOutgoing") },
            { id: "incoming", label: t("transfers", "tabIncoming") },
            { id: "pending", label: `Pending Approval (${pendingForApproval.length})` },
          ]}
          active={activeTab}
          onChange={setActiveTab}
        />
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder={t("transfers", "searchTransfer")} className="min-w-64 flex-1 md:w-72 md:flex-none" />
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="min-w-44 flex-1 md:w-auto md:flex-none">
          <option value="all">{t("transfers", "allStatus")}</option>
          <option value="PENDING">{t("transfers", "pending")}</option>
          <option value="APPROVED">{t("transfers", "approved")}</option>
          <option value="IN_TRANSIT">{t("transfers", "inTransit")}</option>
          <option value="COMPLETED">{t("transfers", "completed")}</option>
          <option value="CANCELED">{t("transfers", "canceled")}</option>
          <option value="REJECTED">{t("transfers", "rejected")}</option>
        </Select>
      </div>

      <div className="mt-5">
        {filteredTransfers.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300/70 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
            {t("transfers", "none")}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200/70 bg-white">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="px-3 py-3 font-medium">{t("transfers", "transferNo")}</th>
                  <th className="px-3 py-3 font-medium">{t("transfers", "from")}</th>
                  <th className="px-3 py-3 font-medium">{t("transfers", "to")}</th>
                  <th className="px-3 py-3 font-medium">{t("transfers", "items")}</th>
                  <th className="px-3 py-3 font-medium">{t("common", "status")}</th>
                  <th className="px-3 py-3 font-medium">{t("transfers", "created")}</th>
                  <th className="px-3 py-3 font-medium">{t("common", "actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredTransfers.map((transfer) => {
                  const fromShop = shops.find((s) => s.id === transfer.fromShopId);
                  const toShop = shops.find((s) => s.id === transfer.toShopId);
                  const items = transferItems.filter((i) => i.transferId === transfer.id);
                  const createdByUser = users.find((u) => u.id === transfer.createdBy);
                  const isFromCurrentShop = transfer.fromShopId === shopId;
                  const isToCurrentShop = transfer.toShopId === shopId;

                  return (
                    <tr key={transfer.id} className="border-b last:border-0">
                      <td className="px-3 py-3 font-medium">{transfer.transferNo}</td>
                      <td className="px-3 py-3">{fromShop?.name ?? transfer.fromShopId}</td>
                      <td className="px-3 py-3">{toShop?.name ?? transfer.toShopId}</td>
                      <td className="px-3 py-3">{items.length} {t("transfers", "itemsSuffix")}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge color={statusColors[transfer.status]}>{statusLabels[transfer.status]}</Badge>
                          {transfer.pendingSync && <Badge tone="amber">Pending sync</Badge>}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div>{formatDateTime(transfer.createdAt)}</div>
                        <div className="text-xs text-slate-500">{t("transfers", "by")} {createdByUser?.name ?? t("transfers", "unknown")}</div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setShowDetailModal(transfer.id)}>
                            {t("transfers", "view")}
                          </Button>
                          {isFromCurrentShop && transfer.status === "PENDING" && isManager && (
                            <>
                              <Button size="sm" variant="primary" onClick={() => handleApprove(transfer.id)}>
                                {t("transfers", "approve")}
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => handleReject(transfer.id)}>
                                {t("transfers", "reject")}
                              </Button>
                            </>
                          )}
                          {isFromCurrentShop && transfer.status === "APPROVED" && isManager && (
                            <Button size="sm" variant="primary" onClick={() => handleDispatch(transfer.id)}>
                              {t("transfers", "dispatch")}
                            </Button>
                          )}
                          {isToCurrentShop && transfer.status === "IN_TRANSIT" && isManager && (
                            <Button size="sm" variant="primary" onClick={() => setReceiveTransferId(transfer.id)}>
                              {t("transfers", "receive")}
                            </Button>
                          )}
                          {transfer.status === "PENDING" && (
                            <Button size="sm" variant="ghost" onClick={() => handleCancel(transfer.id)}>
                              {t("transfers", "cancel")}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Transfer Modal */}
      <Modal open={showCreateModal} onClose={() => setShowCreateModal(false)} title={t("transfers", "createTitle")} size="xl">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("transfers", "destinationShop")}</label>
            <Select
              value={newTransfer.toShopId}
              onChange={(e) => setNewTransfer((prev) => ({ ...prev, toShopId: e.target.value }))}
            >
              <option value="">{t("transfers", "selectShop")}</option>
              {shops.filter((s) => s.id !== shopId).map((shop) => (
                <option key={shop.id} value={shop.id}>{shop.name}</option>
              ))}
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("transfers", "addProducts")}</label>
            <Select onChange={(e) => { if (e.target.value) addItemToTransfer(e.target.value); e.target.value = ""; }}>
              <option value="">{t("transfers", "selectProduct")}</option>
              {products
                .filter((p) => canAddProductToTransfer(p.id))
                .map((product) => {
                  const availableBase = getAvailableBase(product.id);
                  return (
                    <option key={product.id} value={product.id}>
                      {product.name} ({t("transfers", "available")}: {formatStockQuantity(availableBase, productUnits, product.id, product.unitType)})
                    </option>
                  );
                })}
            </Select>
            <p className="mt-1 text-xs text-slate-500">
              {t("transfers", "unitHelp")}
            </p>
          </div>

          {newTransfer.items.length > 0 && (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[920px] text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left">{t("transfers", "product")}</th>
                    <th className="px-3 py-2 text-left">{t("transfers", "colUnit")}</th>
                    <th className="px-3 py-2 text-right">{t("transfers", "colUnitQty")}</th>
                    <th className="px-3 py-2 text-right">{t("transfers", "colMoves")}</th>
                    <th className="px-3 py-2 text-left">{t("transfers", "available")}</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {newTransfer.items.map((item) => {
                    const product = products.find((p) => p.id === item.productId);
                    const availableBase = getAvailableBase(item.productId);
                    const baseUnitName = product?.unitType || "unit";
                    const units = getTransferUnits(item.productId);
                    const usedUnitIds = new Set(
                      newTransfer.items
                        .filter((line) => line.productId === item.productId && line.lineId !== item.lineId)
                        .map((line) => line.productUnitId)
                    );
                    const selectableUnits = units.filter(
                      (unit) => unit.id === item.productUnitId || !usedUnitIds.has(unit.id)
                    );
                    const selectedUnit = units.find((unit) => unit.id === item.productUnitId);
                    const maxQty = getMaxTransferUnitQuantity(
                      newTransfer.items,
                      item,
                      productUnits,
                      availableBase
                    );
                    const previewBase = convertToBaseQuantity(item.selectedUnitQuantity, selectedUnit);
                    const exceedsStock = transferProductExceedsStock(
                      newTransfer.items,
                      item.productId,
                      productUnits,
                      availableBase
                    );
                    return (
                      <tr key={item.lineId} className="border-t align-top">
                        <td className="px-3 py-2">
                          <div className="font-medium">{product?.name}</div>
                          {selectedUnit && selectedUnit.baseQuantity > 1 && (
                            <div className="text-xs text-slate-500">
                              1 {selectedUnit.name} = {selectedUnit.baseQuantity} {baseUnitName}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Select
                            value={item.productUnitId}
                            onChange={(e) => updateItemUnit(item.lineId, e.target.value)}
                          >
                            {selectableUnits.map((unit) => (
                              <option key={unit.id} value={unit.id}>
                                {unit.name}{unit.baseQuantity > 1 ? ` (x${unit.baseQuantity})` : ""}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min="1"
                            max={Math.max(1, maxQty)}
                            value={item.selectedUnitQuantity}
                            onChange={(e) => updateItemQty(item.lineId, parseInt(e.target.value, 10) || 1)}
                            className="min-h-10 w-20 rounded border px-2 py-1 text-right"
                          />
                          <div className="mt-1 text-xs text-slate-500">{t("transfers", "max")} {maxQty}</div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div>{previewBase} {baseUnitName}</div>
                          {selectedUnit && (
                            <div className="text-xs text-slate-500">
                              {t("transfers", "enteredAs")} {item.selectedUnitQuantity} {selectedUnit.name}
                            </div>
                          )}
                          {exceedsStock && (
                            <div className="text-xs font-medium text-red-600">
                              {t("transfers", "exceeds")}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          <div>{formatStockQuantity(availableBase, productUnits, item.productId, baseUnitName)}</div>
                          <div>{availableBase} {baseUnitName} {t("transfers", "baseSuffix")}</div>
                        </td>
                        <td className="px-3 py-2">
                          <Button size="sm" variant="ghost" onClick={() => removeItemFromTransfer(item.lineId)}>
                            {t("transfers", "remove")}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("transfers", "notesOptional")}</label>
            <textarea
              value={newTransfer.notes}
              onChange={(e) => setNewTransfer((prev) => ({ ...prev, notes: e.target.value }))}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              rows={2}
              placeholder={t("transfers", "reasonPlaceholder")}
            />
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setShowCreateModal(false)}>{t("common", "cancel")}</Button>
            <Button
              onClick={handleCreateTransfer}
              disabled={!newTransfer.toShopId || newTransfer.items.length === 0 || hasInvalidTransferItems}
            >
              {t("transfers", "createTransfer")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Transfer Detail Modal */}
      <Modal
        open={!!showDetailModal}
        onClose={() => setShowDetailModal(null)}
        title={`${t("transfers", "detailTitle")} - ${selectedTransfer?.transferNo}`}
        size="lg"
      >
        {selectedTransfer && (
          <div className="space-y-4">
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <span className="text-slate-500">{t("transfers", "from")}:</span>
                <span className="ml-2 font-medium">{shops.find((s) => s.id === selectedTransfer.fromShopId)?.name}</span>
              </div>
              <div>
                <span className="text-slate-500">{t("transfers", "to")}:</span>
                <span className="ml-2 font-medium">{shops.find((s) => s.id === selectedTransfer.toShopId)?.name}</span>
              </div>
              <div>
                <span className="text-slate-500">{t("common", "status")}:</span>
                <span className="ml-2"><Badge color={statusColors[selectedTransfer.status]}>{statusLabels[selectedTransfer.status]}</Badge></span>
              </div>
              <div>
                <span className="text-slate-500">{t("transfers", "created")}:</span>
                <span className="ml-2">{formatDateTime(selectedTransfer.createdAt)}</span>
              </div>
              {selectedTransfer.approvedAt && (
                <div>
                  <span className="text-slate-500">{t("transfers", "approvedLabel")}:</span>
                  <span className="ml-2">{formatDateTime(selectedTransfer.approvedAt)}</span>
                </div>
              )}
              {selectedTransfer.completedAt && (
                <div>
                  <span className="text-slate-500">{t("transfers", "completedLabel")}:</span>
                  <span className="ml-2">{formatDateTime(selectedTransfer.completedAt)}</span>
                </div>
              )}
            </div>

            {selectedTransfer.notes && (
              <div className="text-sm">
                <span className="text-slate-500">{t("transfers", "notes")}:</span>
                <p className="mt-1">{selectedTransfer.notes}</p>
              </div>
            )}

            {selectedTransfer.cancelReason && (
              <div className="text-sm bg-red-50 p-3 rounded-lg">
                <span className="text-red-700 font-medium">{t("transfers", "cancelReason")}:</span>
                <p className="mt-1 text-red-600">{selectedTransfer.cancelReason}</p>
              </div>
            )}

            <div>
              <h4 className="font-medium mb-2">{t("transfers", "items")}</h4>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left">{t("transfers", "product")}</th>
                      <th className="px-3 py-2 text-right">{t("transfers", "enteredAs")}</th>
                      <th className="px-3 py-2 text-right">{t("transfers", "baseRequested")}</th>
                      <th className="px-3 py-2 text-right">{t("transfers", "baseApproved")}</th>
                      <th className="px-3 py-2 text-right">{t("transfers", "baseTransferred")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedTransferItems.map((item) => {
                    const product = products.find((p) => p.id === item.productId);
                    const baseUnitName = product?.unitType || "unit";
                    const fallbackUnit = productUnits.find((unit) => unit.id === item.productUnitId);
                    const enteredAs = formatEnteredAs(item, fallbackUnit);
                    return (
                        <tr key={item.id} className="border-t">
                          <td className="px-3 py-2">{product?.name}</td>
                          <td className="px-3 py-2 text-right">
                            {enteredAs ?? formatBaseQty(item.requestedQty, baseUnitName)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatBaseQty(item.requestedQty, baseUnitName)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatBaseQty(item.approvedQty, baseUnitName)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatBaseQty(item.transferredQty, baseUnitName)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2 pt-4">
              <Button variant="secondary" onClick={() => setShowDetailModal(null)}>{t("common", "close")}</Button>
            </div>
          </div>
        )}
      </Modal>

      <TransferReceiveModal
        transferId={receiveTransferId}
        onClose={() => setReceiveTransferId(null)}
        currentUserId={currentUserId}
      />
    </Card>
  );
};
