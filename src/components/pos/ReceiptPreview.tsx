import type { Sale, Shop, User } from "../../types";
import { formatAmount, formatDateTime, formatMmk } from "../../lib/utils";
import { useTranslation } from "../../hooks/useTranslation";
import { useDataStore } from "../../stores/dataStore";

interface ReceiptLine {
  /** Product name only — unit, price level, etc. live in their own columns. */
  name: string;
  qty: number;
  unitLabel: string;
  unitPriceMmk: number;
  lineTotalMmk: number;
  /** Snapshot of the price level (Retail / Wholesale / Special) when set. */
  priceLevelName?: string;
}

interface ReceiptPreviewProps {
  sale: Sale;
  lines: ReceiptLine[];
  shop: Shop;
  cashier?: User;
  statusNote?: string;
}

// Plain grouped integer (`formatAmount`) inside the items table where the
// "MMK" label would just add noise to every row. The totals block still
// uses `formatMmk` so the currency is shown once, clearly.
const fmtAmount = formatAmount;

const formatCashierName = (name: string | undefined): string => {
  const withoutDigits = (name ?? "").replace(/\d+/g, "").trim();
  return withoutDigits || "-";
};

const PAYMENT_LABEL: Record<string, string> = {
  CASH: "methodCash", BANK_TRANSFER: "methodBank", MOBILE_WALLET: "methodWallet", CARD: "methodCard", OTHER: "methodOther",
};

export const ReceiptPreview = ({ sale, lines, shop, cashier, statusNote }: ReceiptPreviewProps) => {
  const { t } = useTranslation();
  const businessProfile = useDataStore((state) => state.businessProfile);
  const brandName = businessProfile?.businessName?.trim() || "Shwe PhaLar";
  const brandLogo = businessProfile?.logoUrl?.trim() || `${import.meta.env.BASE_URL}logo_real.png`;
  const itemCount = lines.reduce((sum, line) => sum + line.qty, 0);

  // Collect the distinct price-level names used on this receipt. The
  // common case (every line at the same level, usually Retail) collapses
  // into a single meta row, so we don't repeat the same word under every
  // item. Mixed-level carts keep the per-line label so customers can
  // still see which line was Wholesale vs Retail.
  const distinctPriceLevels = Array.from(
    new Set(lines.map((line) => line.priceLevelName).filter((name): name is string => Boolean(name))),
  );
  const singlePriceLevel = distinctPriceLevels.length === 1 ? distinctPriceLevels[0] : null;

  return (
    <div className="receipt rounded-2xl border border-slate-200/70 p-4 shadow-card">
      {/* Brand header */}
      <div className="receipt-header text-center">
        <img
          src={brandLogo}
          alt={brandName}
          // `mix-blend-multiply` is a safety net for white-background
          // PNGs: it blends white pixels into the white card / thermal
          // paper. If the PNG is already transparent it's a no-op.
          // Pure black/dark pixels of the logo remain untouched.
          className="receipt-logo mx-auto mb-2 mix-blend-multiply"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
        {/* Company brand sits above the per-shop name so customers see
            both the umbrella brand and the specific store they bought
            from on the same receipt. */}
        <div className="receipt-brand">{brandName}</div>
        {(shop.address || shop.phone) && (
          <div className="receipt-shop-contact">
            {shop.address && <div>{shop.address}</div>}
            {shop.phone && <div>{t("pos", "receiptTel")}: {shop.phone}</div>}
          </div>
        )}
        <div className="receipt-number">{t("pos", "receiptLine", { no: sale.receiptNo })}</div>
      </div>

      {/* Meta — stacked rows with a fixed-width label column so the
          colons align cleanly and long values (datetime, cashier name)
          can't push the value off the row. Two columns at this width
          forced the long datetime and cashier strings to wrap awkwardly. */}
      <div className="receipt-meta mt-4 text-xs">
        <div className="receipt-meta-row">
          <span className="receipt-meta-label">{t("pos", "receiptBranch")}</span>
          <span className="receipt-meta-sep">:</span>
          <span className="receipt-meta-value">{shop.name}</span>
        </div>
        <div className="receipt-meta-row">
          <span className="receipt-meta-label">{t("pos", "receiptDate")}</span>
          <span className="receipt-meta-sep">:</span>
          <span className="receipt-meta-value">{formatDateTime(sale.createdAt)}</span>
        </div>
        <div className="receipt-meta-row">
          <span className="receipt-meta-label">{t("pos", "receiptCashier")}</span>
          <span className="receipt-meta-sep">:</span>
          <span className="receipt-meta-value">{formatCashierName(cashier?.name)}</span>
        </div>
        <div className="receipt-meta-row">
          <span className="receipt-meta-label">{t("pos", "receiptPrice")}</span>
          <span className="receipt-meta-sep">:</span>
          <span className="receipt-meta-value">{singlePriceLevel ?? "-"}</span>
        </div>
        <div className="receipt-meta-row">
          <span className="receipt-meta-label">{t("pos", "receiptPayment")}</span>
          <span className="receipt-meta-sep">:</span>
          <span className="receipt-meta-value">
            {sale.payments && sale.payments.length > 1
              ? t("fin", "splitPayment")
              : sale.paymentMethod === "CASH" ? t("pos", "cash") : t("pos", "other")}
          </span>
        </div>
        {/* Step 4 (PFIN-D): each payment line of a split / mixed payment, as recorded */}
        {sale.payments && sale.payments.length > 1
          ? sale.payments.map((p) => (
              <div className="receipt-meta-row" key={p.method} data-testid="receipt-payment-line">
                <span className="receipt-meta-label">{t("fin", PAYMENT_LABEL[p.method] ?? "methodOther")}</span>
                <span className="receipt-meta-sep">:</span>
                <span className="receipt-meta-value">
                  {formatMmk(p.amountMmk)}{p.reference ? ` (${p.reference})` : ""}
                </span>
              </div>
            ))
          : null}
        <div className="receipt-meta-row">
          <span className="receipt-meta-label">{t("pos", "receiptItems")}</span>
          <span className="receipt-meta-sep">:</span>
          <span className="receipt-meta-value">{itemCount}</span>
        </div>
      </div>

      {/* Items — proper 4-column table. Description wraps; Qty / Price /
          Amount stay right-aligned and tabular so the eye can scan down
          the column on paper. */}
      <table className="receipt-items mt-4 w-full text-xs">
        <colgroup>
          <col className="receipt-item-description-col" />
          <col className="receipt-item-qty-col" />
          <col className="receipt-item-price-col" />
          <col className="receipt-item-amount-col" />
        </colgroup>
        <thead>
          <tr>
            <th className="text-left">{t("pos", "receiptDescription")}</th>
            <th className="text-left">{t("pos", "receiptQty")}</th>
            <th className="text-right">{t("pos", "receiptPrice")}</th>
            <th className="text-right">{t("pos", "receiptAmount")}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={`${line.name}-${index}`}>
              <td className="receipt-description-cell">
                <div>{line.name}</div>
                {/* Per-line price level shown ONLY when the receipt has
                    mixed levels — single-level receipts surface the
                    label once in the meta block to keep rows clean. */}
                {!singlePriceLevel && line.priceLevelName && (
                  <div className="text-[10px] text-slate-500">
                    {line.priceLevelName}
                  </div>
                )}
              </td>
              <td className="receipt-qty-cell">{line.qty} {line.unitLabel}</td>
              <td className="receipt-money">{fmtAmount(line.unitPriceMmk)}</td>
              <td className="receipt-money">{fmtAmount(line.lineTotalMmk)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals — Subtotal/Discount grouped above; Total bumped in size;
          Paid/Change separated from Total by a thin dashed rule so the
          customer's eye stops on the amount due. */}
      <div className="receipt-totals mt-4 space-y-1 text-xs">
        <div className="flex justify-between">
          <span>{t("pos", "receiptSubtotal")}</span>
          <span>{formatMmk(sale.subtotalMmk)}</span>
        </div>
        <div className="flex justify-between">
          <span>{t("pos", "receiptDiscount")}</span>
          <span>- {formatMmk(sale.discountMmk)}</span>
        </div>
        <div className="my-1 border-t border-dashed border-slate-300" />
        <div className="flex justify-between text-sm font-semibold">
          <span>{t("pos", "total")}</span>
          <span>{formatMmk(sale.totalMmk)}</span>
        </div>
        <div className="my-1 border-t border-dashed border-slate-300" />
        <div className="flex justify-between">
          <span>{t("pos", "receiptPaid")}</span>
          <span>{formatMmk(sale.paidMmk)}</span>
        </div>
        <div className="flex justify-between">
          <span>{t("pos", "change")}</span>
          <span>{formatMmk(sale.changeMmk)}</span>
        </div>
      </div>

      {/* Burmese policy + thank-you footer. Lives below all numeric
          totals so the customer's eye lands on the change line first,
          then this. Centered + slightly larger leading for legibility
          on thermal paper. */}
      <div className="receipt-footer mt-4 border-t border-dashed border-slate-300 pt-3 text-center text-xs leading-relaxed">
        <div>{t("pos", "receiptFooterNoReturn")}</div>
        <div>{t("pos", "receiptFooterThanks")}</div>
      </div>

      {statusNote && (
        <div className="mt-3 text-center text-[10px] text-slate-500">
          {statusNote}
        </div>
      )}
    </div>
  );
};
