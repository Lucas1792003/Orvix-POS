import { useEffect, useMemo, useState } from "react";
import { useAuthStore } from "../stores/authStore";
import { useAppStore } from "../stores/appStore";
import { useDataStore } from "../stores/dataStore";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Tabs } from "../components/ui/Tabs";
import { Pagination } from "../components/ui/Pagination";
import { SearchInput } from "../components/forms/SearchInput";
import { DateRangePicker } from "../components/forms/DateRangePicker";
import { InventoryTable } from "../components/inventory/InventoryTable";
import { MovementsTable } from "../components/inventory/MovementsTable";
import { AdjustStockModal } from "../components/inventory/AdjustStockModal";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { downloadCsv } from "../lib/csv";
import { hasPermission } from "../lib/permissions";
import { reportError } from "../lib/errors";
import { outcomeToast } from "../lib/outcomeToast";
import { classifySubmitFailure } from "../lib/submitOutcome";
import { CategoryFilter } from "../features/categories/CategoryFilter";
import { formatDateTime, getEffectiveShopId } from "../lib/utils";
import { useTranslation } from "../hooks/useTranslation";

const PAGE_SIZE = 10;

export const InventoryPage = () => {
  const { t } = useTranslation();
  const toast = useToast();
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const { currentShopId, setShopId } = useAppStore();
  const shops = useDataStore((state) => state.shops);
  const products = useDataStore((state) => state.products);
  const categories = useDataStore((state) => state.categories);
  const inventory = useDataStore((state) => state.inventory);
  const stockPendingConfirmation = useDataStore((state) => state.stockPendingConfirmation);
  const movements = useDataStore((state) => state.movements);
  const productUnits = useDataStore((state) => state.productUnits);
  const adjustStock = useDataStore((state) => state.adjustStock);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [activeTab, setActiveTab] = useState("stock");
  const [adjustProductId, setAdjustProductId] = useState<string | null>(null);
  const [movementSearch, setMovementSearch] = useState("");
  const [range, setRange] = useState({ start: "", end: "" });

  // Pagination state
  const [stockPage, setStockPage] = useState(1);
  const [movementPage, setMovementPage] = useState(1);

  const shopId = getEffectiveShopId(currentUser, currentShopId, shops);
  const hasShop = !!shopId;

  // Permission gating: stock availability is broadly visible, but movement
  // history and manual adjustment are restricted (cashiers see stock only).
  // Manual adjustment is additionally gated on having a shop selected — the
  // backend `adjust_stock` RPC rejects null/empty shop_id, and we don't want
  // an admin with no shop selected to even reach the modal.
  const canViewMovements = hasPermission(currentUser, "inventory:view_movements");
  const canAdjust = hasPermission(currentUser, "inventory:adjust") && hasShop;
  const effectiveTab = activeTab === "movements" && !canViewMovements ? "stock" : activeTab;

  const stockRows = useMemo(() => {
    return products
      .filter((product) => product.name.toLowerCase().includes(search.toLowerCase()))
      .filter((product) => category === "all" || product.category === category)
      .map((product) => {
        const record = inventory.find((item) => item.shopId === shopId && item.productId === product.id);
        const qty = record?.qtyBaseUnits ?? 0;
        // D-NEW-1: deductions awaiting the server are already in `qty`.
        const unconfirmed = shopId ? stockPendingConfirmation?.[`${shopId}|${product.id}`] ?? 0 : 0;
        const productMovements = movements.filter((movement) => movement.shopId === shopId && movement.productId === product.id);
        const lastMovement = productMovements[0]?.createdAt ?? "";
        return { product, qty, lastMovement, unconfirmed };
      });
  }, [products, inventory, movements, search, category, shopId, stockPendingConfirmation]);

  const filteredMovements = useMemo(() => {
    return movements.filter((movement) => {
      if (movement.shopId !== shopId) return false;
      const product = products.find((item) => item.id === movement.productId);
      const matchesSearch = product?.name.toLowerCase().includes(movementSearch.toLowerCase()) ?? false;
      const movementDate = movement.createdAt.slice(0, 10);
      const afterStart = !range.start || movementDate >= range.start;
      const beforeEnd = !range.end || movementDate <= range.end;
      return matchesSearch && afterStart && beforeEnd;
    });
  }, [movements, shopId, products, movementSearch, range]);

  // Reset page when filters change
  useEffect(() => { setStockPage(1); }, [search, category]);
  useEffect(() => { setMovementPage(1); }, [movementSearch, range]);

  // Paginated data
  const stockTotalPages = Math.max(1, Math.ceil(stockRows.length / PAGE_SIZE));
  const paginatedStockRows = stockRows.slice((stockPage - 1) * PAGE_SIZE, stockPage * PAGE_SIZE);

  const movementTotalPages = Math.max(1, Math.ceil(filteredMovements.length / PAGE_SIZE));
  const paginatedMovements = filteredMovements.slice((movementPage - 1) * PAGE_SIZE, movementPage * PAGE_SIZE);

  const exportInventory = () => {
    const rows = stockRows.map(({ product, qty, lastMovement }) => ({
      product: product.name,
      category: product.category,
      qtyBaseUnits: qty,
      lastMovement: lastMovement ? formatDateTime(lastMovement) : "",
    }));
    downloadCsv("inventory.csv", rows);
  };

  // Admin shop picker. On-hand and movements are shop-scoped, so an admin
  // browsing inventory wants to switch shops without leaving the page.
  // Non-admin users are locked to their assigned shop and never see this.
  const isAdmin = currentUser?.role === "ADMIN";

  return (
    <Card>
      <PageHeader
        title={t("inventory", "title")}
        subtitle={t("inventory", "subtitle")}
        actions={<Button variant="secondary" onClick={exportInventory}>{t("inventory", "exportCsv")}</Button>}
      />

      {!hasShop && (
        <div className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-4 text-sm text-slate-600">
          {t("inventory", "noShopSelected")}
          {currentUser?.role === "ADMIN"
            ? t("inventory", "noShopAdminHint")
            : t("inventory", "noShopStaffHint")}
        </div>
      )}

      {/* Admin shop picker — pill row matching the Tabs design but in
          emerald so the two filter bars don't look identical. Hidden
          for non-admins (they're locked to their assigned shop). */}
      {isAdmin && (
        <div className="mt-6 inline-flex max-w-full flex-wrap rounded-full border border-slate-200 bg-white p-1 shadow-sm">
          {shops.map((shop) => {
            const active = shop.id === currentShopId;
            return (
              <button
                key={shop.id}
                type="button"
                onClick={() => setShopId(shop.id)}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                  active
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                title={shop.address || shop.name}
              >
                {shop.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-4">
        <Tabs
          tabs={[
            { id: "stock", label: t("inventory", "stockTab") },
            ...(canViewMovements ? [{ id: "movements", label: t("inventory", "movementsTab") }] : []),
          ]}
          active={effectiveTab}
          onChange={setActiveTab}
        />
      </div>

      {effectiveTab === "stock" && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput value={search} onChange={setSearch} placeholder={t("inventory", "searchProduct")} className="min-w-64 flex-1 md:w-96 md:flex-none" />
          </div>
          {/* Category filter — shared icon-chip filter (no native dropdown) */}
          <CategoryFilter
            categories={categories}
            selectedCategory={category}
            onChange={setCategory}
          />
          <InventoryTable
            rows={paginatedStockRows}
            productUnits={productUnits}
            categories={categories}
            onAdjust={canAdjust ? setAdjustProductId : undefined}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-slate-500">
              {t("inventory", "showing")} {stockRows.length === 0 ? 0 : ((stockPage - 1) * PAGE_SIZE) + 1}-{Math.min(stockPage * PAGE_SIZE, stockRows.length)} {t("inventory", "of")} {stockRows.length} {t("inventory", "products")}
            </span>
            <Pagination page={stockPage} totalPages={stockTotalPages} onChange={setStockPage} />
          </div>
        </div>
      )}

      {effectiveTab === "movements" && canViewMovements && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput value={movementSearch} onChange={setMovementSearch} placeholder={t("inventory", "filterByProduct")} className="min-w-64 flex-1 md:w-96 md:flex-none" />
            <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
          </div>
          {filteredMovements.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300/70 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
              {t("inventory", "noMovements")}
            </div>
          ) : (
            <>
              <MovementsTable movements={paginatedMovements} products={products} />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm text-slate-500">
                  {t("inventory", "showing")} {filteredMovements.length === 0 ? 0 : ((movementPage - 1) * PAGE_SIZE) + 1}-{Math.min(movementPage * PAGE_SIZE, filteredMovements.length)} {t("inventory", "of")} {filteredMovements.length} {t("inventory", "movements")}
                </span>
                <Pagination page={movementPage} totalPages={movementTotalPages} onChange={setMovementPage} />
              </div>
            </>
          )}
        </div>
      )}

      <AdjustStockModal
        open={!!adjustProductId}
        onClose={() => setAdjustProductId(null)}
        product={adjustProductId ? products.find((p) => p.id === adjustProductId) ?? null : null}
        productUnits={productUnits}
        onSave={async ({ type, qtyChange, reason, productUnitId, unitQty }) => {
          if (!adjustProductId || !currentUserId) return false;
          try {
            await adjustStock({
              shopId,
              productId: adjustProductId,
              type,
              qtyChange,
              // Required and already trimmed by the modal; no silent
              // default that would satisfy the server's check (ORV-058).
              reason,
              actorId: currentUserId,
              productUnitId,
              unitQty,
            });
            setAdjustProductId(null);
            return true;
          } catch (error) {
            const failTitle = t("inventory", "adjustFailed");
            const item = outcomeToast(error, t, failTitle, failTitle);
            switch (classifySubmitFailure(error)) {
              case "pending":
                // Outcome unknown: kept with its key and confirmed by the
                // till. Close and clear the form — entering it again would
                // be a second adjustment (lib/submitOutcome.ts).
                toast(item);
                setAdjustProductId(null);
                return true;
              case "not-sent":
                // An earlier attempt is unresolved; nothing was sent. Keep the form.
                toast(item);
                return false;
              default:
                // Confirmed failure (incl. 087 recovery refusal: nothing recorded).
                toast({ ...item, description: reportError("InventoryPage.adjustStock", error, failTitle) });
                return false;
            }
          }
        }}
      />
    </Card>
  );
};
