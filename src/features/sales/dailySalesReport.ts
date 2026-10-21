import { toCsv, type CsvCell } from "../../lib/csv";
import { formatDate, formatDateTime } from "../../lib/utils";
import { businessDayKey } from "../../lib/businessDay";
import type { Product, Sale, SaleItem, Shift, Shop, User } from "../../types";

export const dailySalesReportHeaders = [
  "Report Date",
  "Branch",
  "Branch Code",
  "Receipt No",
  "Sale Date Time",
  "Cashier Name",
  "Cashier Email",
  "Payment Method",
  "Sale Status",
  "Receipt Line",
  "Price Level",
  "Product Name",
  "Product SKU",
  "Product Alias",
  "Unit",
  "Quantity",
  "Unit Price MMK",
  "Item Discount %",
  "Line Total MMK",
  "Subtotal MMK",
  "Sale Discount MMK",
  "Cart Discount %",
  "Total MMK",
  "Paid MMK",
  "Change MMK",
];

interface DailySalesReportInput {
  reportDate: string;
  sales: Sale[];
  saleItems: SaleItem[];
  products: Product[];
  users: User[];
  shops: Shop[];
}

/**
 * The business day (`YYYY-MM-DD`, Asia/Yangon) of an instant — the day a
 * sale belongs to in the daily report (ORV-069). Kept under its old name
 * for callers; it no longer follows the device clock. Unparseable input
 * yields "" (matches no report day).
 */
export const getLocalDateValue = (value: string | number | Date = new Date()) =>
  businessDayKey(value) ?? "";

const getDateFromLocalValue = (dateValue: string) => {
  const [year, month, day] = dateValue.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
};

const sortSalesNewestFirst = (a: Sale, b: Sale) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.receiptNo.localeCompare(a.receiptNo);

export interface OpenShiftNoticeEntry {
  cashier: string;
  branch: string;
}

export interface OpenShiftNotice {
  openShiftCount: number;
  entries: OpenShiftNoticeEntry[];
  /** One-line human summary suitable for an email subject or toast. */
  summary: string;
}

/**
 * Build a "data may be incomplete" notice when one or more cashier
 * shifts are still open at report-send time. Returns null when every
 * shift is closed, so the caller can skip the notice entirely. The
 * notice is informational only — it does NOT block the report; the
 * email body renders the summary as a banner so the admin knows which
 * branches haven't finalised yet.
 */
export const getOpenShiftReportNotice = (
  shifts: Shift[],
  users: User[],
  shops: Shop[],
): OpenShiftNotice | null => {
  const openShifts = shifts.filter((shift) => !shift.endedAt);
  if (openShifts.length === 0) return null;

  const usersById = new Map(users.map((user) => [user.id, user]));
  const shopsById = new Map(shops.map((shop) => [shop.id, shop]));
  const entries: OpenShiftNoticeEntry[] = openShifts.map((shift) => ({
    cashier: usersById.get(shift.cashierId)?.name ?? shift.cashierId,
    branch: shopsById.get(shift.shopId)?.name ?? shift.shopId,
  }));

  const examples = entries.slice(0, 4).map((entry) => `${entry.cashier} at ${entry.branch}`);
  const remaining = entries.length > examples.length ? `, +${entries.length - examples.length} more` : "";
  const summary = `${entries.length} shift${entries.length === 1 ? "" : "s"} still open at report time: ${examples.join(", ")}${remaining}.`;

  return { openShiftCount: entries.length, entries, summary };
};

/**
 * Sanitize a shop code for use inside a filename. Falls back to the
 * shop id so the per-shop CSVs are still distinguishable when an
 * admin hasn't set a code.
 */
const fileSafeShopKey = (shop: Shop | undefined, shopId: string): string => {
  const raw = (shop?.code || shopId || "shop").trim();
  const normalised = raw
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalised || "shop";
};

interface CsvRowsResult {
  rows: Record<string, CsvCell>[];
  saleCount: number;
}

const buildCsvRowsForSales = (
  salesForShop: Sale[],
  reportDateLabel: string,
  context: {
    shopsById: Map<string, Shop>;
    usersById: Map<string, User>;
    productsById: Map<string, Product>;
    saleItemsBySaleId: Map<string, SaleItem[]>;
  },
): CsvRowsResult => {
  const rows: Record<string, CsvCell>[] = [];

  salesForShop.forEach((sale) => {
    const shop = context.shopsById.get(sale.shopId);
    const cashier = context.usersById.get(sale.cashierId);
    const items = context.saleItemsBySaleId.get(sale.id) ?? [];
    const saleFields = {
      "Report Date": reportDateLabel,
      Branch: shop?.name ?? sale.shopId,
      "Branch Code": shop?.code ?? "",
      "Receipt No": sale.receiptNo,
      "Sale Date Time": formatDateTime(sale.createdAt),
      "Cashier Name": cashier?.name ?? sale.cashierId,
      "Cashier Email": cashier?.email ?? "",
      "Payment Method": sale.paymentMethod,
      "Sale Status": sale.status,
      "Subtotal MMK": sale.subtotalMmk,
      "Sale Discount MMK": sale.discountMmk,
      "Cart Discount %": sale.cartDiscountPct ?? "",
      "Total MMK": sale.totalMmk,
      "Paid MMK": sale.paidMmk,
      "Change MMK": sale.changeMmk,
    };

    if (items.length === 0) {
      rows.push({
        ...saleFields,
        "Receipt Line": "",
        "Price Level": "",
        "Product Name": "",
        "Product SKU": "",
        "Product Alias": "",
        Unit: "",
        Quantity: "",
        "Unit Price MMK": "",
        "Item Discount %": "",
        "Line Total MMK": "",
      });
      return;
    }

    items.forEach((item, index) => {
      const product = context.productsById.get(item.productId);
      rows.push({
        ...saleFields,
        "Receipt Line": index + 1,
        "Price Level": item.priceLevelNameSnapshot ?? "",
        "Product Name": product?.name ?? item.productId,
        "Product SKU": product?.sku ?? "",
        "Product Alias": product?.aliasCode ?? "",
        Unit: item.unitNameSnapshot ?? item.unitLabel ?? "",
        Quantity: item.qtyUnits,
        "Unit Price MMK": item.unitPriceMmk,
        "Item Discount %": item.itemDiscountPct ?? "",
        "Line Total MMK": item.lineTotalMmk,
      });
    });
  });

  return { rows, saleCount: salesForShop.length };
};

const indexInputs = (input: DailySalesReportInput) => {
  const shopsById = new Map(input.shops.map((shop) => [shop.id, shop]));
  const usersById = new Map(input.users.map((user) => [user.id, user]));
  const productsById = new Map(input.products.map((product) => [product.id, product]));
  const saleItemsBySaleId = new Map<string, SaleItem[]>();
  input.saleItems.forEach((item) => {
    const existing = saleItemsBySaleId.get(item.saleId);
    if (existing) existing.push(item);
    else saleItemsBySaleId.set(item.saleId, [item]);
  });
  return { shopsById, usersById, productsById, saleItemsBySaleId };
};

// ============================================================
// Per-shop report bundle — one CSV per shop with sales on the day.
// ============================================================

export interface DailyShopSalesReport {
  shopId: string;
  shopName: string;
  shopCode: string;
  filename: string;
  csv: string;
  rowCount: number;
  saleCount: number;
}

export interface DailySalesReportBundle {
  reportDate: string;
  reportDateLabel: string;
  subject: string;
  /** One report per shop that had at least one sale on the report date. */
  shopReports: DailyShopSalesReport[];
  totalSaleCount: number;
  totalRowCount: number;
}

/**
 * Split the day's sales into per-shop CSV bundles. Only shops that
 * actually had a sale on the report date are included — empty CSVs
 * would just be noise in the admin's inbox. The order matches the
 * shop's `name` so the email summary reads alphabetically.
 */
export const buildDailySalesReportsByShop = (
  input: DailySalesReportInput,
): DailySalesReportBundle => {
  const context = indexInputs(input);
  const reportDateLabel = formatDate(getDateFromLocalValue(input.reportDate));
  const dailySales = input.sales
    .filter((sale) => getLocalDateValue(sale.createdAt) === input.reportDate)
    .sort(sortSalesNewestFirst);

  const salesByShop = new Map<string, Sale[]>();
  for (const sale of dailySales) {
    const list = salesByShop.get(sale.shopId);
    if (list) list.push(sale);
    else salesByShop.set(sale.shopId, [sale]);
  }

  const shopReports: DailyShopSalesReport[] = [];
  let totalSaleCount = 0;
  let totalRowCount = 0;

  for (const [shopId, salesForShop] of salesByShop) {
    const shop = context.shopsById.get(shopId);
    const { rows, saleCount } = buildCsvRowsForSales(salesForShop, reportDateLabel, context);
    const shopKey = fileSafeShopKey(shop, shopId);
    shopReports.push({
      shopId,
      shopName: shop?.name ?? shopId,
      shopCode: shop?.code ?? "",
      filename: `daily-sales-${shopKey}-${input.reportDate}.csv`,
      csv: toCsv(rows, dailySalesReportHeaders),
      rowCount: rows.length,
      saleCount,
    });
    totalSaleCount += saleCount;
    totalRowCount += rows.length;
  }

  shopReports.sort((a, b) => a.shopName.localeCompare(b.shopName));

  return {
    reportDate: input.reportDate,
    reportDateLabel,
    subject: `Shwe PhaLar daily sales report - ${reportDateLabel}`,
    shopReports,
    totalSaleCount,
    totalRowCount,
  };
};
