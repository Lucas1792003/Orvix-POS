import { useState } from "react";
import type { CartItem } from "../../types";
import { CartItemRow } from "./CartItemRow";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { formatMmk, toNumber } from "../../lib/utils";
import { useTranslation } from "../../hooks/useTranslation";
import type { CartItemStockStatus } from "../../features/pos/cartStock";

interface CartPanelProps {
  items: CartItem[];
  subtotal: number;
  itemDiscount: number;
  cartDiscount: number;
  total: number;
  cartDiscountPct: number;
  onDiscountChange: (id: string, value: number) => void;
  onQtyChange: (id: string, delta: number) => void;
  onQtySet: (id: string, qty: number) => void;
  onRemove: (id: string) => void;
  onCartDiscountChange: (value: number) => void;
  /** Called when the cashier confirms the bill. `printAfterSave` is set
   *  by the "Save & Print" button (F3). The parent owns navigation + the
   *  print trigger; this component just emits intent. */
  onCheckout: (printAfterSave: boolean) => void;
  onOverridePrice?: (item: CartItem) => void;
  stockStatuses?: Record<string, CartItemStockStatus>;
  checkoutDisabled?: boolean;
  checkoutHelper?: string;
  /** Step 6 (PDISC-A): this discount needs a separate approval — its state and the "Request approval" action. */
  discountApproval?: DiscountApprovalNotice;
}

export interface DiscountApprovalNotice {
  tone: "warning" | "info" | "success" | "error";
  message: string;
  action?: { label: string; disabled: boolean; onClick: () => void };
}

const NOTICE_TONE: Record<DiscountApprovalNotice["tone"], string> = {
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  info: "border-sky-200 bg-sky-50 text-sky-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-rose-200 bg-rose-50 text-rose-800",
};

export const CartPanel = ({
  items,
  subtotal,
  itemDiscount,
  cartDiscount,
  total,
  cartDiscountPct,
  onDiscountChange,
  onQtyChange,
  onQtySet,
  onRemove,
  onCartDiscountChange,
  onCheckout,
  onOverridePrice,
  stockStatuses = {},
  checkoutDisabled = items.length === 0,
  checkoutHelper,
  discountApproval,
}: CartPanelProps) => {
  const [showAllOpen, setShowAllOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold text-slate-800">{t("pos", "bills")}</h2>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-700">
            {t("pos", "itemsCount", { n: items.length })}
          </span>
          <button
            type="button"
            onClick={() => setShowAllOpen(true)}
            disabled={items.length === 0}
            className="inline-flex min-h-9 items-center gap-1 rounded-full border border-emerald-200 bg-white px-2.5 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300 disabled:hover:bg-white"
            title={t("pos", "showAllTitle")}
          >
            <span className="material-symbols-rounded text-sm">list_alt</span>
            {t("common", "all")}
          </button>
        </div>
      </div>

      {/* Cart Items - Scrollable */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 py-12 text-center">
            <span className="material-symbols-rounded mb-2 text-4xl text-slate-300">shopping_cart</span>
            <p className="text-sm text-slate-500">{t("pos", "cartEmpty")}</p>
            <p className="text-xs text-slate-400">{t("pos", "cartEmptyHint")}</p>
          </div>
        ) : (
          items.map((item) => (
            <CartItemRow
              key={item.id}
              item={item}
              onQtyChange={onQtyChange}
              onQtySet={onQtySet}
              onRemove={onRemove}
              onDiscountChange={onDiscountChange}
              onOverridePrice={onOverridePrice}
              stockStatus={stockStatuses[item.id]}
            />
          ))
        )}
      </div>

      {/* Summary */}
      <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500">{t("pos", "subTotal")}</span>
          <span className="font-semibold text-slate-700">{formatMmk(subtotal)}</span>
        </div>

        {(itemDiscount > 0 || cartDiscountPct > 0) && (
          <>
            {itemDiscount > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">{t("pos", "itemDiscounts")}</span>
                <span className="font-semibold text-rose-500">- {formatMmk(itemDiscount)}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-slate-500">
                {t("pos", "discountPct")}
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={cartDiscountPct || ""}
                  onChange={(event) => onCartDiscountChange(toNumber(event.target.value))}
                  className="h-7 min-h-7 w-16 text-center text-xs"
                  placeholder="0"
                />
              </span>
              <span className="font-semibold text-rose-500">- {formatMmk(cartDiscount)}</span>
            </div>
          </>
        )}

        {cartDiscountPct === 0 && itemDiscount === 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-slate-500">
              {t("pos", "discountPct")}
              <Input
                type="number"
                min={0}
                max={100}
                value={cartDiscountPct || ""}
                onChange={(event) => onCartDiscountChange(toNumber(event.target.value))}
                className="h-7 min-h-7 w-16 text-center text-xs"
                placeholder="0"
              />
            </span>
            <span className="font-semibold text-slate-400">- {formatMmk(0)}</span>
          </div>
        )}

        {discountApproval ? (
          <div role="status" data-testid="discount-approval" className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs font-medium ${NOTICE_TONE[discountApproval.tone]}`}>
            <span className="min-w-0 flex-1">{discountApproval.message}</span>
            {discountApproval.action ? (
              <Button variant="secondary" className="h-8 min-h-8 px-3 text-xs" onClick={discountApproval.action.onClick} disabled={discountApproval.action.disabled}>
                {discountApproval.action.label}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="h-px bg-slate-200" />

        <div className="flex items-center justify-between gap-3">
          <span className="text-lg font-bold text-slate-800">{t("pos", "total")}</span>
          <span className="text-right text-xl font-bold text-emerald-600">{formatMmk(total)}</span>
        </div>
      </div>

      {/* Checkout buttons — Place Order is the primary action and takes
          the remaining width; Print is a compact secondary action so the
          ratio reflects how often each is used in practice. */}
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Button
          className="flex-1 whitespace-nowrap bg-emerald-600 py-3 text-sm font-semibold hover:bg-emerald-700"
          onClick={() => onCheckout(false)}
          disabled={checkoutDisabled}
        >
          <span className="material-symbols-rounded mr-1 text-base">point_of_sale</span>
          {t("pos", "placeOrder")}
        </Button>
        <Button
          className="whitespace-nowrap bg-emerald-600 py-3 text-sm font-semibold hover:bg-emerald-700"
          onClick={() => onCheckout(true)}
          disabled={checkoutDisabled}
        >
          <span className="material-symbols-rounded mr-1 text-base">print</span>
          {t("pos", "printOrder")}
        </Button>
      </div>
      {checkoutHelper && (
        <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-center text-xs font-medium text-slate-500">
          {checkoutHelper}
        </p>
      )}

      <Modal
        open={showAllOpen}
        onClose={() => setShowAllOpen(false)}
        title={t("pos", "allBillItems")}
        description={t("pos", "itemsInCart", { n: items.length })}
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => setShowAllOpen(false)}>
            {t("common", "close")}
          </Button>
        }
      >
        <div className="max-h-[65vh] space-y-2 overflow-y-auto pr-1">
          {items.map((item) => (
            <CartItemRow
              key={item.id}
              item={item}
              onQtyChange={onQtyChange}
              onQtySet={onQtySet}
              onRemove={onRemove}
              onDiscountChange={onDiscountChange}
              onOverridePrice={onOverridePrice}
              stockStatus={stockStatuses[item.id]}
            />
          ))}
        </div>
      </Modal>
    </div>
  );
};
