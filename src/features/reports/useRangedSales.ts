import { useEffect, useState } from "react";
import { reportError } from "../../lib/errors";
import { businessDayStart, addDays, isDayKey } from "../../lib/businessDay";
import { fetchAllRows, fetchAllRowsIn } from "../../stores/data/fetchAll";
import { mapRefund } from "../../stores/data/mappers";
import type { RefundForMetrics } from "../dashboard/dashboardMetrics";
import type { PaymentMethod, SaleStatus } from "../../types";

// Reports must aggregate over the FULL selected date range, but the data store
// caps cached sales at the most-recent 1000 rows. This hook fetches the sales
// (and their line items and refund/void requests) for a [start, end] range
// straight from Supabase — RLS-scoped to what the user may see — so reports
// never under-count. Only the fields the reports use are selected/mapped.
//
// The range is in BUSINESS days (Asia/Yangon, ORV-069): `start`/`end` are
// `YYYY-MM-DD` and the query bounds are the UTC instants of business midnight.
// A bare `${start}T00:00:00` was compared in the server's UTC session time
// zone, so sales between 00:00 and 06:30 Yangon fell on the wrong day.

/** Inclusive UTC bounds for business days `start`…`end`. The read helper
 *  offers gte/lte only, so the end is the last MICROSECOND before the next
 *  business midnight — Postgres keeps microseconds, and a 1 ms gap would
 *  drop a sale stamped e.g. 23:59:59.999400 from both days. */
export const rangedSalesBounds = (start: string, end: string): { from: string; to: string } => {
  const lastMs = new Date(businessDayStart(addDays(end, 1)).getTime() - 1).toISOString(); // …:59.999Z
  return {
    from: businessDayStart(start).toISOString(),
    to: `${lastMs.slice(0, -1)}999Z`, // …:59.999999Z
  };
};

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
  /** Refund/void requests on those sales (all statuses; the metrics keep
   *  only approved PARTIAL refunds). */
  refunds: RefundForMetrics[];
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
  const [refunds, setRefunds] = useState<RefundForMetrics[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A half-typed or impossible date is "no range yet", not a query.
    if (!start || !end || !isDayKey(start) || !isDayKey(end)) {
      setSales([]);
      setSaleItems([]);
      setRefunds([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const bounds = rangedSalesBounds(start, end);

    (async () => {
      try {
        // Every page (ORV-001): an unpaged read stopped silently at the
        // server's 1,000-row cap and the report under-counted.
        const salesRes = await fetchAllRows({
          table: "sales",
          keys: ["id"],
          columns: "id, shop_id, status, total_mmk, payment_method, created_at",
          filter: (q) => {
            const ranged = q.gte("created_at", bounds.from).lte("created_at", bounds.to);
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

        // Refund/void requests for the same sales (ORV-034): a partly
        // refunded sale is REFUNDED and must be reported net of what was
        // handed back. Same id-batching as the line items.
        const refundsRes = await fetchAllRowsIn({
          table: "refund_void_requests",
          keys: ["id"],
          columns: "id, sale_id, shop_id, type, status, items, reason, created_by, created_at",
          column: "sale_id",
          values: rangedSales.map((s) => s.id),
          chunkSize: 200,
        });
        if (refundsRes.error) throw refundsRes.error;
        const rangedRefunds: RefundForMetrics[] = (refundsRes.data ?? []).map(mapRefund);

        if (cancelled) return;
        setSales(rangedSales);
        setSaleItems(rangedItems);
        setRefunds(rangedRefunds);
      } catch (err) {
        if (cancelled) return;
        setError(reportError("useRangedSales", err, "Failed to load report data."));
        setSales([]);
        setSaleItems([]);
        setRefunds([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [start, end, shopId]);

  return { sales, saleItems, refunds, loading, error };
};
