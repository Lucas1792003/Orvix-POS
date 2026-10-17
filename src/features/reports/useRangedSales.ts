import { useEffect, useState } from "react";
import { reportError } from "../../lib/errors";
import { fetchAllRows, fetchAllRowsIn } from "../../stores/data/fetchAll";
import type { PaymentMethod, SaleStatus } from "../../types";

// Reports must aggregate over the FULL selected date range, but the data store
// caps cached sales at the most-recent 1000 rows. This hook fetches the sales
// (and their line items) for a [start, end] range straight from Supabase —
// RLS-scoped to what the user may see — so reports never under-count. Only the
// fields the reports use are selected/mapped.

export interface RangedSale {
  id: string;
  shopId: string;
  status: SaleStatus;
  totalMmk: number;
  paymentMethod: PaymentMethod;
  createdAt: string;
}
export interface RangedSaleItem {
  saleId: string;
  productId: string;
  qtyUnits: number;
  /** Cost captured at sale time (migration 041); undefined on legacy rows. */
  unitCostMmkSnapshot?: number;
}

interface RangedSalesResult {
  sales: RangedSale[];
  saleItems: RangedSaleItem[];
  loading: boolean;
  error: string | null;
}

/**
 * Fetch sales + line items for a date range (YYYY-MM-DD, inclusive). `shopId`
 * null = all shops the user can see. Empty start/end short-circuits to no data
 * (callers seed a sensible default range).
 */
export const useRangedSales = (
  start: string,
  end: string,
  shopId: string | null,
): RangedSalesResult => {
  const [sales, setSales] = useState<RangedSale[]>([]);
  const [saleItems, setSaleItems] = useState<RangedSaleItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!start || !end) {
      setSales([]);
      setSaleItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Every page (ORV-001): an unpaged read stopped silently at the
        // server's 1,000-row cap and the report under-counted.
        const salesRes = await fetchAllRows({
          table: "sales",
          keys: ["id"],
          columns: "id, shop_id, status, total_mmk, payment_method, created_at",
          filter: (q) => {
            const ranged = q.gte("created_at", `${start}T00:00:00`).lte("created_at", `${end}T23:59:59.999`);
            return shopId ? ranged.eq("shop_id", shopId) : ranged;
          },
        });
        if (salesRes.error) throw salesRes.error;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rangedSales: RangedSale[] = (salesRes.data ?? []).map((r: any) => ({
          id: r.id,
          shopId: r.shop_id,
          status: r.status,
          totalMmk: r.total_mmk,
          paymentMethod: r.payment_method,
          createdAt: r.created_at,
        }));

        // Line items for those sales, in id-batches (URL length), each batch
        // paged — a batch of 200 sales can have more than 1,000 lines.
        const itemsRes = await fetchAllRowsIn({
          table: "sale_items",
          keys: ["id"],
          columns: "id, sale_id, product_id, qty_units, unit_cost_mmk_snapshot",
          column: "sale_id",
          values: rangedSales.map((s) => s.id),
          chunkSize: 200,
        });
        if (itemsRes.error) throw itemsRes.error;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rangedItems: RangedSaleItem[] = (itemsRes.data as any[]).map((r) => ({
          saleId: r.sale_id,
          productId: r.product_id,
          qtyUnits: r.qty_units,
          unitCostMmkSnapshot: r.unit_cost_mmk_snapshot ?? undefined,
        }));

        if (cancelled) return;
        setSales(rangedSales);
        setSaleItems(rangedItems);
      } catch (err) {
        if (cancelled) return;
        setError(reportError("useRangedSales", err, "Failed to load report data."));
        setSales([]);
        setSaleItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [start, end, shopId]);

  return { sales, saleItems, loading, error };
};
