import type { ReactNode } from "react";
import type { Sale, Shop, User } from "../../types";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { Table, TableContainer, TBody, TD, TH, THead, TR } from "../ui/Table";
import { formatAmount, formatDateTime } from "../../lib/utils";

/** One priced line on the voucher grid. `code` is the product SKU / alias
 *  shown in the Code column; everything else mirrors the receipt line. */
export interface VoucherLine {
  code: string;
  name: string;
  qty: number;
  unitLabel: string;
  priceLevelName?: string;
  unitPriceMmk: number;
  lineTotalMmk: number;
}

interface SaleVoucherProps {
  sale: Sale;
  lines: VoucherLine[];
  shop: Shop;
  cashier?: User;
  /** Rendered in the right column — the live receipt preview (logo + totals). */
  aside?: ReactNode;
}

const statusTone = (status: Sale["status"]) =>
  status === "NORMAL" ? "green" : status === "VOID" ? "red" : "amber";

// Grid cells show plain grouped integers (`formatAmount`) — the currency is
// shown once in the receipt preview, so per-row "MMK" labels would just add
// noise the way they do on the thermal receipt.
const fmtAmount = formatAmount;

export const SaleVoucher = ({ sale, lines, shop, cashier, aside }: SaleVoucherProps) => {
  const meta = [
    { label: "Date", value: formatDateTime(sale.createdAt) },
    { label: "Branch", value: shop.name },
    { label: "Cashier", value: cashier?.name ?? "-" },
    { label: "Payment", value: sale.paymentMethod },
  ];

  return (
    <div className="space-y-4">
      {/* Voucher header strip — receipt no + status on the left, the key
          meta fields laid out as a responsive grid on the right. */}
      <Card>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Sales Voucher</div>
              <div className="font-mono text-lg font-semibold text-slate-900">{sale.receiptNo}</div>
            </div>
            <Badge tone={statusTone(sale.status)}>{sale.status}</Badge>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4 lg:text-right">
            {meta.map((row) => (
              <div key={row.label} className="min-w-0">
                <dt className="text-xs uppercase tracking-wide text-slate-400">{row.label}</dt>
                <dd className="truncate font-medium text-slate-700">{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Line-item grid */}
        <TableContainer>
          <Table className="min-w-[680px]">
            <THead>
              <TR>
                <TH className="w-10 text-right">#</TH>
                <TH>Code</TH>
                <TH>Description</TH>
                <TH className="text-right">Qty</TH>
                <TH>Unit</TH>
                <TH>Level</TH>
                <TH className="text-right">Sale Price</TH>
                <TH className="text-right">Amount</TH>
              </TR>
            </THead>
            <TBody>
              {lines.map((line, index) => (
                <TR key={`${line.code}-${index}`}>
                  <TD className="text-right tabular-nums text-slate-400">{index + 1}</TD>
                  <TD className="font-mono text-xs text-slate-500">{line.code || "—"}</TD>
                  <TD className="font-medium text-slate-800">{line.name}</TD>
                  <TD className="text-right tabular-nums">{line.qty}</TD>
                  <TD className="text-slate-500">{line.unitLabel}</TD>
                  <TD className="text-slate-500">{line.priceLevelName ?? "—"}</TD>
                  <TD className="text-right tabular-nums">{fmtAmount(line.unitPriceMmk)}</TD>
                  <TD className="text-right font-medium tabular-nums">{fmtAmount(line.lineTotalMmk)}</TD>
                </TR>
              ))}
              {lines.length === 0 && (
                <TR>
                  <TD className="py-6 text-center text-slate-400" colSpan={8}>
                    No line items on this sale.
                  </TD>
                </TR>
              )}
            </TBody>
          </Table>
        </TableContainer>

        {/* Receipt preview — the actual voucher with logo, branding, and
            totals, exactly as it prints. */}
        {aside && (
          <Card className="h-fit">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-400">
              Receipt preview
            </div>
            {aside}
          </Card>
        )}
      </div>
    </div>
  );
};
