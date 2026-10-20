import { useMemo, useState } from "react";
import { useCanViewCost } from "../lib/useCanViewCost";
import { useAuthStore } from "../stores/authStore";
import { useAppStore } from "../stores/appStore";
import { useDataStore } from "../stores/dataStore";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { SearchInput } from "../components/forms/SearchInput";
import { ProductPicker } from "../components/products/ProductPicker";
import { useToast } from "../components/ui/Toast";
import { getPriceTierProductError } from "../features/pricing/priceTierForm";
import { formatMmk, getEffectiveShopId } from "../lib/utils";
import { newId } from "../lib/id";
import { reportError } from "../lib/errors";
import type { PriceTier } from "../types";

export const PricingPage = () => {
  const canViewCost = useCanViewCost();
  const toast = useToast();
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((u) => u.id === currentUserId));
  const { currentShopId } = useAppStore();
  const shops = useDataStore((state) => state.shops);
  const categories = useDataStore((state) => state.categories);
  const products = useDataStore((state) => state.products);
  const barcodes = useDataStore((state) => state.barcodes);
  const inventory = useDataStore((state) => state.inventory);
  const priceTiers = useDataStore((state) => state.priceTiers);

  const addPriceTier = useDataStore((state) => state.addPriceTier);
  const updatePriceTier = useDataStore((state) => state.updatePriceTier);
  const deletePriceTier = useDataStore((state) => state.deletePriceTier);

  const [search, setSearch] = useState("");
  const [productFilter, setProductFilter] = useState("all");
  const [showModal, setShowModal] = useState(false);
  const [editingTier, setEditingTier] = useState<PriceTier | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    productId: "",
    shopId: "",
    minQty: 1,
    maxQty: "",
    priceMmk: 0,
  });

  const shopId = getEffectiveShopId(currentUser, currentShopId, shops);
  const isAdmin = currentUser?.role === "ADMIN";

  const shopStockByProductId = useMemo(() => {
    const stockByProductId: Record<string, number> = {};
    inventory
      .filter((item) => item.shopId === shopId)
      .forEach((item) => {
        stockByProductId[item.productId] = item.qtyBaseUnits;
      });
    return stockByProductId;
  }, [inventory, shopId]);

  // Group tiers by product
  const tiersByProduct = useMemo(() => {
    const grouped = new Map<string, PriceTier[]>();
    priceTiers
      .filter((t) => !t.shopId || t.shopId === shopId || isAdmin)
      .forEach((tier) => {
        const existing = grouped.get(tier.productId) ?? [];
        grouped.set(tier.productId, [...existing, tier]);
      });
    return grouped;
  }, [priceTiers, shopId, isAdmin]);

  // Filter products
  const filteredProducts = products.filter((p) => {
    const hasSearch = p.name.toLowerCase().includes(search.toLowerCase());
    const hasTiers = productFilter === "all" || (productFilter === "with_tiers" && tiersByProduct.has(p.id));
    return hasSearch && (productFilter === "all" || hasTiers);
  });

  const openCreateModal = (productId?: string) => {
    setEditingTier(null);
    setFormError(null);
    const product = productId ? products.find((p) => p.id === productId) : null;
    setForm({
      productId: productId ?? "",
      shopId: "",
      minQty: 1,
      maxQty: "",
      priceMmk: product?.priceMmk ?? 0,
    });
    setShowModal(true);
  };

  const openEditModal = (tier: PriceTier) => {
    setEditingTier(tier);
    setFormError(null);
    setForm({
      productId: tier.productId,
      shopId: tier.shopId ?? "",
      minQty: tier.minQty,
      maxQty: tier.maxQty?.toString() ?? "",
      priceMmk: tier.priceMmk,
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    const productError = getPriceTierProductError(form.productId, products);
    if (productError) {
      setFormError(productError);
      return;
    }

    if (form.minQty < 1 || form.priceMmk < 0) {
      setFormError("Please fill all required fields");
      return;
    }
    if (!currentUserId) return;

    const tierData: PriceTier = {
      id: editingTier?.id ?? newId("tier"),
      productId: form.productId,
      shopId: form.shopId || undefined,
      minQty: form.minQty,
      maxQty: form.maxQty ? parseInt(form.maxQty) : undefined,
      priceMmk: form.priceMmk,
      isActive: editingTier?.isActive ?? true,
      createdAt: editingTier?.createdAt ?? new Date().toISOString(),
      createdBy: editingTier?.createdBy ?? currentUserId,
    };

    try {
      if (editingTier) {
        await updatePriceTier(tierData);
      } else {
        await addPriceTier(tierData);
      }
      setFormError(null);
      setShowModal(false);
    } catch (error) {
      setFormError(reportError("PricingPage.save", error, "Failed to save price tier"));
    }
  };

  const pickerProducts = useMemo(() => {
    const activeProducts = products.filter((product) => product.isActive);
    const selectedProduct = form.productId
      ? products.find((product) => product.id === form.productId)
      : undefined;

    if (selectedProduct && !activeProducts.some((product) => product.id === selectedProduct.id)) {
      return [selectedProduct, ...activeProducts];
    }

    return activeProducts;
  }, [products, form.productId]);

  const selectedProduct = products.find((product) => product.id === form.productId);
  const productFormError =
    formError && (formError.includes("Product") || formError.includes("product"))
      ? formError
      : null;
  const selectedProductAvailabilityError = form.productId
    ? getPriceTierProductError(form.productId, products)
    : null;
  const productFieldError = productFormError ?? selectedProductAvailabilityError;

  const handleDelete = async (tierId: string) => {
    if (!confirm("Are you sure you want to delete this price tier?")) return;
    try {
      await deletePriceTier(tierId);
    } catch (error) {
      toast({
        variant: "error",
        title: "Failed to delete price tier",
        description: reportError("PricingPage.delete", error, "Failed to delete price tier"),
      });
    }
  };

  const toggleActive = async (tier: PriceTier) => {
    try {
      await updatePriceTier({ ...tier, isActive: !tier.isActive });
    } catch (error) {
      toast({
        variant: "error",
        title: "Failed to update price tier",
        description: reportError("PricingPage.toggleActive", error, "Failed to update price tier"),
      });
    }
  };

  return (
    <Card>
      <PageHeader
        title="Tier-Based Pricing"
        subtitle="Configure quantity-based price breaks for products"
        actions={
          isAdmin && (
            <Button onClick={() => openCreateModal()}>Add Price Tier</Button>
          )
        }
      />

      <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <h4 className="font-medium text-blue-800 mb-2">How Tier Pricing Works</h4>
        <ul className="text-sm text-blue-700 space-y-1">
          <li>- Price tiers are automatically applied in POS based on quantity</li>
          <li>- Higher quantities = lower per-unit price (bulk discounts)</li>
          <li>- Shop-specific tiers override global tiers for that shop</li>
          <li>- Tiers apply only to the default/base sellable unit; packs/cases use their configured Product Unit price</li>
          <li>- Example: 1-9 units = $10, 10-49 units = $9, 50+ units = $8</li>
        </ul>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search products..." className="min-w-64 flex-1 md:w-80 md:flex-none" />
        <Select value={productFilter} onChange={(e) => setProductFilter(e.target.value)} className="min-w-48 flex-1 md:w-auto md:flex-none">
          <option value="all">All Products</option>
          <option value="with_tiers">Products with Tiers</option>
        </Select>
      </div>

      <div className="mt-5 space-y-6">
        {filteredProducts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300/70 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
            No products found.
          </div>
        ) : (
          filteredProducts.map((product) => {
            const tiers = (tiersByProduct.get(product.id) ?? []).sort((a, b) => a.minQty - b.minQty);
            return (
              <div key={product.id} className="overflow-hidden rounded-lg border">
                <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 px-4 py-3">
                  <div className="min-w-0">
                    <h4 className="font-medium">{product.name}</h4>
                    <p className="text-sm text-slate-500">
                      Base Price: MMK {product.priceMmk.toLocaleString()}
                      {canViewCost && product.costMmk !== undefined && <> | Cost: MMK {product.costMmk.toLocaleString()}</>}
                    </p>
                  </div>
                  {isAdmin && (
                    <Button size="sm" variant="secondary" onClick={() => openCreateModal(product.id)}>
                      Add Tier
                    </Button>
                  )}
                </div>

                {tiers.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-sm">
                      <thead>
                        <tr className="border-b text-left text-slate-500">
                          <th className="px-4 py-2 font-medium">Quantity Range</th>
                          <th className="px-4 py-2 font-medium">Price per Unit</th>
                          <th className="px-4 py-2 font-medium">Shop</th>
                          <th className="px-4 py-2 font-medium">Status</th>
                          <th className="px-4 py-2 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tiers.map((tier) => {
                        const shop = tier.shopId ? shops.find((s) => s.id === tier.shopId) : null;
                        const discount = ((product.priceMmk - tier.priceMmk) / product.priceMmk * 100).toFixed(1);
                        return (
                          <tr key={tier.id} className="border-b last:border-0">
                            <td className="px-4 py-2">
                              {tier.minQty} - {tier.maxQty ?? "unlimited"}
                            </td>
                            <td className="px-4 py-2">
                              <span className="font-medium">MMK {tier.priceMmk.toLocaleString()}</span>
                              {tier.priceMmk < product.priceMmk && (
                                <span className="ml-2 text-green-600 text-xs">(-{discount}%)</span>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              {shop ? (
                                <Badge color="blue">{shop.name}</Badge>
                              ) : (
                                <Badge color="gray">All Shops</Badge>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              <Badge color={tier.isActive ? "green" : "gray"}>
                                {tier.isActive ? "Active" : "Inactive"}
                              </Badge>
                            </td>
                            <td className="px-4 py-2">
                              <div className="flex flex-wrap gap-2">
                                <Button size="sm" variant="ghost" onClick={() => openEditModal(tier)}>
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => toggleActive(tier)}
                                >
                                  {tier.isActive ? "Disable" : "Enable"}
                                </Button>
                                {isAdmin && (
                                  <Button size="sm" variant="danger" onClick={() => handleDelete(tier.id)}>
                                    Delete
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
                ) : (
                  <div className="px-4 py-3 text-sm text-slate-500">
                    No price tiers configured. Using base price for all quantities.
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Add/Edit Price Tier Modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={editingTier ? "Edit Price Tier" : "Add Price Tier"}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Product <span className="text-red-500">*</span>
            </label>
            <ProductPicker
              products={pickerProducts}
              categories={categories}
              barcodes={barcodes}
              value={form.productId}
              onSelect={(productId) => {
                const product = products.find((p) => p.id === productId);
                setForm({ ...form, productId, priceMmk: product?.priceMmk ?? 0 });
                setFormError(null);
              }}
              placeholder="Search and select a product..."
              disabled={!!editingTier}
              error={productFieldError ?? undefined}
              shopStockByProductId={shopStockByProductId}
              showStock={!!shopId}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Shop (optional)</label>
            <Select
              value={form.shopId}
              onChange={(e) => {
                setForm({ ...form, shopId: e.target.value });
                setFormError(null);
              }}
            >
              <option value="">All Shops (Global)</option>
              {shops.map((shop) => (
                <option key={shop.id} value={shop.id}>{shop.name}</option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-slate-500">Leave empty to apply to all shops</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Min Quantity <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min="1"
                value={form.minQty}
                onChange={(e) => {
                  setForm({ ...form, minQty: parseInt(e.target.value) || 1 });
                  setFormError(null);
                }}
                className="min-h-11 w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Max Quantity</label>
              <input
                type="number"
                min={form.minQty}
                value={form.maxQty}
                onChange={(e) => {
                  setForm({ ...form, maxQty: e.target.value });
                  setFormError(null);
                }}
                className="min-h-11 w-full rounded-lg border px-3 py-2 text-sm"
                placeholder="Unlimited"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Price per Unit (MMK) <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min="0"
              value={form.priceMmk}
              onChange={(e) => {
                setForm({ ...form, priceMmk: parseInt(e.target.value) || 0 });
                setFormError(null);
              }}
              className="min-h-11 w-full rounded-lg border px-3 py-2 text-sm"
            />
            {selectedProduct && (
              <p className="mt-1 text-xs text-slate-500">
                Base price: {formatMmk(selectedProduct.priceMmk)}
              </p>
            )}
          </div>

          {formError && !productFormError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
              {formError}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button onClick={handleSave}>{editingTier ? "Update" : "Create"}</Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
};
