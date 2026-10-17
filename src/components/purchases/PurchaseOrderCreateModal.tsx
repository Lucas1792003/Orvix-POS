import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { Badge } from "../ui/Badge";
import { useToast } from "../ui/Toast";
import { mayAlreadyBeRecorded, outcomeToast } from "../../lib/outcomeToast";
import { useTranslation } from "../../hooks/useTranslation";
import { useDataStore } from "../../stores/dataStore";
import type { Product, Supplier, SupplierProduct } from "../../types";

interface PurchaseOrderCreateModalProps {
  open: boolean;
  onClose: () => void;
  // Shop the PO will be raised against. Caller (page) already picked the
  // effective shop from getEffectiveShopId; this component just submits it.
  shopId: string;
  // The ID of the current user — required by the RPC. Falsy disables submit.
  currentUserId: string | null | undefined;
  // Pre-selected supplier. When set, the supplier picker is collapsed to a
  // read-only label so the user can't accidentally raise a PO against a
  // different supplier when starting from the supplier workspace.
  defaultSupplierId?: string;
  // Active suppliers to choose from when defaultSupplierId is not set.
  suppliers: Supplier[];
  // Active products to add as PO lines.
  products: Product[];
  // Supplier⇄product links. When the selected supplier has any, the product
  // picker defaults to that supplier's products (with a "show all" override).
  supplierProducts: SupplierProduct[];
  // Called after the RPC resolves successfully. Useful for the supplier
  // workspace to re-focus the newly-created PO.
  onCreated?: (purchaseOrderId: string) => void;
}

interface DraftItem {
  productId: string;
  orderedQty: number;
  unitCostMmk: number;
}

export const PurchaseOrderCreateModal = ({
  open,
  onClose,
  shopId,
  currentUserId,
  defaultSupplierId,
  suppliers,
  products,
  supplierProducts,
  onCreated,
}: PurchaseOrderCreateModalProps) => {
  const createPurchaseOrder = useDataStore((state) => state.createPurchaseOrder);
  const toast = useToast();
  const { t } = useTranslation();

  const [supplierId, setSupplierId] = useState(defaultSupplierId ?? "");
  const [items, setItems] = useState<DraftItem[]>([]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // When the supplier has linked products, the picker shows only those by
  // default; this toggle lets the user fall back to the full catalog.
  const [showAllProducts, setShowAllProducts] = useState(false);

  // Reset form whenever the modal is (re-)opened or the pre-selected supplier
  // changes; keeps state clean across reopens without leaking previous draft.
  useEffect(() => {
    if (!open) return;
    setSupplierId(defaultSupplierId ?? "");
    setItems([]);
    setNotes("");
    setSubmitting(false);
    setShowAllProducts(false);
  }, [open, defaultSupplierId]);

  const addItem = (productId: string) => {
    if (!productId || items.some((item) => item.productId === productId)) return;
    const product = products.find((p) => p.id === productId);
    setItems((prev) => [...prev, { productId, orderedQty: 1, unitCostMmk: product?.costMmk ?? 0 }]);
  };

  const updateItem = (productId: string, field: "orderedQty" | "unitCostMmk", value: number) => {
    setItems((prev) =>
      prev.map((item) =>
        item.productId === productId
          ? { ...item, [field]: Math.max(field === "orderedQty" ? 1 : 0, value) }
          : item
      )
    );
  };

  const removeItem = (productId: string) => {
    setItems((prev) => prev.filter((item) => item.productId !== productId));
  };

  const total = items.reduce((sum, item) => sum + item.orderedQty * item.unitCostMmk, 0);
  const lockedSupplier = defaultSupplierId
    ? suppliers.find((supplier) => supplier.id === defaultSupplierId) ?? null
    : null;
  const canSubmit =
    Boolean(currentUserId) && Boolean(supplierId) && items.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || !currentUserId) return;
    setSubmitting(true);
    try {
      const id = await createPurchaseOrder({
        shopId,
        supplierId,
        items,
        notes,
        createdBy: currentUserId,
      });
      toast({ title: "Purchase order created", variant: "success" });
      onCreated?.(id);
      onClose();
    } catch (error) {
      // Unknown outcome → "pending confirmation" (never "could not create"),
      // and the form closes so the same order is not entered again.
      toast(outcomeToast(error, t, "Could not create purchase order", "Please try again."));
      if (mayAlreadyBeRecorded(error)) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  // Products linked to the chosen supplier (if any). Used to soft-filter the
  // picker so the common case (ordering a product the supplier sells) is quick.
  const linkedProductIds = supplierId
    ? new Set(
        supplierProducts.filter((link) => link.supplierId === supplierId).map((link) => link.productId)
      )
    : new Set<string>();
  const hasLinkedProducts = linkedProductIds.size > 0;
  // Filter to the supplier's products only when it has some and the user hasn't
  // asked to see all. A supplier with no links never blocks ordering.
  const restrictToSupplier = hasLinkedProducts && !showAllProducts;

  const eligibleProducts = products.filter(
    (p) =>
      p.isActive &&
      !items.some((item) => item.productId === p.id) &&
      (!restrictToSupplier || linkedProductIds.has(p.id))
  );

  return (
    <Modal open={open} onClose={() => (submitting ? undefined : onClose())} title="Create Purchase Order" size="xl">
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Supplier</label>
          {lockedSupplier ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
              {lockedSupplier.name}{" "}
              <span className="ml-1 font-mono text-xs text-slate-500">{lockedSupplier.code}</span>
            </div>
          ) : (
            <Select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              <option value="">Select supplier…</option>
              {suppliers
                .filter((supplier) => supplier.isActive)
                .map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
            </Select>
          )}
        </div>

        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <label className="block text-sm font-medium text-slate-700">Add products</label>
            {hasLinkedProducts && (
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  checked={showAllProducts}
                  onChange={(event) => setShowAllProducts(event.target.checked)}
                />
                Show all products
              </label>
            )}
          </div>
          <Select
            value=""
            onChange={(event) => {
              if (event.target.value) addItem(event.target.value);
              event.target.value = "";
            }}
          >
            <option value="">
              {restrictToSupplier ? "Select a product this supplier sells…" : "Select product to add…"}
            </option>
            {eligibleProducts.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
                {product.purchaseType ? ` [${product.purchaseType}]` : ""}
                {" "}(Cost: MMK {product.costMmk?.toLocaleString() ?? 0})
              </option>
            ))}
          </Select>
        </div>

        {items.length > 0 && (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left">Qty</th>
                  <th className="px-3 py-2 text-left">Unit Cost</th>
                  <th className="px-3 py-2 text-right">Line Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const product = products.find((p) => p.id === item.productId);
                  return (
                    <tr key={item.productId} className="border-t">
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{product?.name ?? item.productId}</span>
                          {product?.purchaseType && (
                            <Badge tone={product.purchaseType === "COD" ? "amber" : "blue"}>
                              {product.purchaseType}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={1}
                          value={item.orderedQty}
                          onChange={(event) =>
                            updateItem(item.productId, "orderedQty", parseInt(event.target.value, 10) || 1)
                          }
                          className="min-h-10 w-20 rounded border px-2 py-1"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          value={item.unitCostMmk}
                          onChange={(event) =>
                            updateItem(item.productId, "unitCostMmk", parseInt(event.target.value, 10) || 0)
                          }
                          className="min-h-10 w-24 rounded border px-2 py-1"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-medium">
                        MMK {(item.orderedQty * item.unitCostMmk).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        <Button size="sm" variant="ghost" onClick={() => removeItem(item.productId)}>
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t bg-slate-50">
                  <td colSpan={3} className="px-3 py-2 text-right font-medium">
                    Total:
                  </td>
                  <td className="px-3 py-2 text-right font-bold">MMK {total.toLocaleString()}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
            rows={2}
            placeholder="Additional notes…"
          />
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create order"}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
