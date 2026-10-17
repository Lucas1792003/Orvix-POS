import type { Category, Product, ProductUnit } from "../../types";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Table, TBody, TD, TH, THead, TR } from "../ui/Table";
import { StockBadge } from "./StockBadge";
import { formatDateTime } from "../../lib/utils";
import { formatStockQuantity } from "../../features/inventory/stockDisplay";
import { useTranslation } from "../../hooks/useTranslation";

interface InventoryRow {
  product: Product;
  qty: number;
  lastMovement?: string;
  /** Base units of this till's deductions not yet confirmed by the server
   *  (already subtracted from `qty`; D-NEW-1). */
  unconfirmed?: number;
}

interface InventoryTableProps {
  rows: InventoryRow[];
  /**
   * All product units in the store. Used to render the human-friendly
   * "8 Package 22 Can" line under the raw base-unit count. Pass an empty
   * array (or omit) to fall back to the raw count + `product.unitType`.
   */
  productUnits?: ProductUnit[];
  /**
   * Active categories from the store. Used solely to resolve the badge
   * colour for the Category cell so the cell matches the Products admin
   * styling. Omit to fall back to a neutral slate tone.
   */
  categories?: Category[];
  /** Omit to render the table read-only (no Adjust action / column). */
  onAdjust?: (productId: string) => void;
}

export const InventoryTable = ({
  rows,
  productUnits = [],
  categories = [],
  onAdjust,
}: InventoryTableProps) => {
  // Resolve the same Category badge tone the Products admin uses so the
  // cells render identically across the two pages. Unknown categories fall
  // back to slate instead of inventing a fresh palette here.
  const { t } = useTranslation();
  const getCategoryColor = (categoryName: string) =>
    categories.find((c) => c.name === categoryName)?.color ?? "slate";

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200/70 bg-white">
      <Table className="min-w-[640px]">
        <THead>
          <TR>
            <TH>Product</TH>
            <TH>Category</TH>
            <TH>On-hand</TH>
            <TH>Last movement</TH>
            {onAdjust && <TH></TH>}
          </TR>
        </THead>
        <TBody>
          {rows.map(({ product, qty, lastMovement, unconfirmed = 0 }) => {
            // Inventory is stored in base units; the decomposed label is a
            // display-only convenience computed at render time.
            const decomposedLabel = formatStockQuantity(
              qty,
              productUnits,
              product.id,
              product.unitType,
            );
            const baseUnitLabel = product.unitType || "unit";
            // Suppress the second line when the decomposition matches the
            // primary "<n> <unit>" string — avoids noisy duplicates for
            // single-tier products (e.g. a product whose only unit is
            // baseQuantity 1).
            const primary = `${qty} ${baseUnitLabel}`.trim();
            const showSecondary = decomposedLabel !== String(qty) && decomposedLabel !== primary;
            return (
              <TR key={product.id}>
                <TD>
                  <div className="flex items-center gap-3 min-w-[200px]">
                    <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded-lg bg-slate-100">
                      {product.imageUrl ? (
                        <img
                          src={product.imageUrl}
                          alt={product.name}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-slate-400">
                          <span className="material-symbols-rounded text-lg">inventory_2</span>
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="font-medium text-slate-800">{product.name}</div>
                      {product.sku && (
                        <div className="text-xs font-mono text-slate-500">{product.sku}</div>
                      )}
                    </div>
                  </div>
                </TD>
                <TD>
                  <Badge tone={getCategoryColor(product.category)}>{product.category}</Badge>
                </TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <StockBadge qty={qty} lowThreshold={product.lowStockThreshold} />
                    <span className="font-medium">{qty} {baseUnitLabel}</span>
                  </div>
                  {showSecondary && (
                    <div className="mt-0.5 text-xs text-slate-500">{decomposedLabel}</div>
                  )}
                  {unconfirmed > 0 && (
                    // This till's deductions the server has not confirmed yet
                    // (already subtracted from On-hand). Number first, so it
                    // stays readable when the label wraps at narrow widths.
                    <div
                      className="mt-1 inline-flex max-w-[14rem] items-start gap-1 rounded-md bg-sky-50 px-1.5 py-0.5 text-xs font-medium leading-snug text-sky-800 ring-1 ring-sky-200"
                      title={t("inventory", "pendingConfirmationHint", { n: unconfirmed })}
                    >
                      <span className="material-symbols-rounded text-sm leading-none" aria-hidden>hourglass_top</span>
                      <span><span className="font-semibold">−{unconfirmed}</span> · {t("inventory", "pendingConfirmation")}</span>
                    </div>
                  )}
                </TD>
                <TD>{lastMovement ? formatDateTime(lastMovement) : "-"}</TD>
                {onAdjust && (
                  <TD>
                    <Button variant="secondary" size="sm" onClick={() => onAdjust(product.id)}>
                      Adjust
                    </Button>
                  </TD>
                )}
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
};
