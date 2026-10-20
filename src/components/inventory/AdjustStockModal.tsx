import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { REASON_MAX_LENGTH, normalizeReason } from "../ui/reasonInput";
import { toNumber } from "../../lib/utils";
import type { Product, ProductUnit, StockMovementType } from "../../types";
import { getActiveProductUnits, getDefaultProductUnit } from "../../features/catalog/productUnits";
import { convertToBaseQuantity } from "../../features/inventory/stockDisplay";

type AdjustmentType = "ADJUSTMENT" | "DAMAGE" | "PURCHASE_IN" | "RETURN_IN";

interface AdjustStockModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Save handler. When the admin picks a non-base sellable unit, the
   * modal sends `productUnitId` + `unitQty`; the server uses those to
   * compute the base delta. `qtyChange` is the **direction-only** sign
   * (±1) in that case — the legacy base-units path still sends a real
   * signed magnitude.
   *
   * `reason` is always a trimmed, non-empty string and the quantity a
   * whole number > 0 (ORV-058). Resolve `true` once saved: only then is the
   * form cleared. Resolve `false` (or throw) on failure — the form keeps
   * what was typed so the user can retry.
   */
  onSave: (payload: {
    type: StockMovementType;
    qtyChange: number;
    reason: string;
    productUnitId?: string;
    unitQty?: number;
  }) => Promise<boolean> | boolean;
  /** Optional — when provided, the modal renders a Unit picker per migration 028. */
  product?: Product | null;
  productUnits?: ProductUnit[];
}

export const AdjustStockModal = ({
  open,
  onClose,
  onSave,
  product = null,
  productUnits = [],
}: AdjustStockModalProps) => {
  const [type, setType] = useState<AdjustmentType>("ADJUSTMENT");
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [qty, setQty] = useState(0);
  const [unitId, setUnitId] = useState("");
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  // Synchronous guard against a double click in one frame (state lags a render).
  const inFlight = useRef(false);
  const fieldId = useId();

  const activeUnits = useMemo(() => {
    if (!product) return [];
    const active = getActiveProductUnits(product.id, productUnits);
    if (active.length > 0) return active;
    // Fall back to the synthesized default unit so the picker still shows
    // something usable for legacy products that have no `product_units` rows.
    return [getDefaultProductUnit(product, productUnits)];
  }, [product, productUnits]);

  // Initial unit selection: default unit (base_quantity=1) so the modal
  // opens in the same behaviour as the legacy version.
  useEffect(() => {
    if (!open) return;
    const next = activeUnits.find((u) => u.isDefault) ?? activeUnits[0];
    setUnitId(next?.id ?? "");
  }, [open, activeUnits]);

  const selectedUnit = activeUnits.find((u) => u.id === unitId);
  const baseUnitName = product?.unitType ?? "unit";
  const previewBase = selectedUnit
    ? convertToBaseQuantity(qty, selectedUnit)
    : qty;

  // ORV-058: no silent default reason (the page used to send "Manual
  // adjustment", which defeated the server's required-reason check), no
  // zero/fractional quantity, and the form is cleared only after a save
  // succeeded — not before it resolved.
  const trimmedReason = normalizeReason(reason);
  const qtyValid = Number.isInteger(qty) && qty > 0;
  const reasonError = submitted && !trimmedReason;
  const qtyError = submitted && !qtyValid;

  const resetForm = () => {
    setType("ADJUSTMENT");
    setDirection("add");
    setQty(0);
    setReason("");
    setSubmitted(false);
  };

  const handleClose = () => {
    if (inFlight.current) return;
    // A cancelled form must not carry into the next product's adjustment.
    resetForm();
    onClose();
  };

  const handleSave = async () => {
    if (inFlight.current) return;
    setSubmitted(true);
    if (!qtyValid || !trimmedReason) return;
    // Direction → sign. For DAMAGE always negative; for stock-in always
    // positive; for ADJUSTMENT use the picker.
    let sign = 1;
    if (type === "ADJUSTMENT") {
      sign = direction === "remove" ? -1 : 1;
    } else if (type === "DAMAGE") {
      sign = -1;
    }
    // Legacy mode (no unit picker) sends a signed base-unit magnitude
    // directly. Unit-aware mode just sends ±1 as a direction hint and
    // lets the server compute the magnitude from unitQty × base_quantity.
    const legacy = !selectedUnit || selectedUnit.baseQuantity === 1;
    const qtyChange = legacy ? sign * qty : sign * 1;

    inFlight.current = true;
    setSaving(true);
    let saved = false;
    try {
      saved = await onSave({
        type,
        qtyChange,
        reason: trimmedReason,
        productUnitId: legacy ? undefined : selectedUnit.id,
        unitQty: legacy ? undefined : qty,
      });
    } catch {
      saved = false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
    if (saved) resetForm();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Adjust Stock"
      description="Record an inventory movement."
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save adjustment"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Movement Type</label>
          <Select value={type} disabled={saving} onChange={(event) => setType(event.target.value as AdjustmentType)}>
            <option value="ADJUSTMENT">Manual Adjustment</option>
            <option value="DAMAGE">Damage / Expired Write-off</option>
            <option value="PURCHASE_IN">Stock In (Purchase)</option>
            <option value="RETURN_IN">Customer Return</option>
          </Select>
        </div>

        {type === "ADJUSTMENT" && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Direction</label>
            <Select value={direction} disabled={saving} onChange={(event) => setDirection(event.target.value as "add" | "remove")}>
              <option value="add">Add to Stock</option>
              <option value="remove">Remove from Stock</option>
            </Select>
          </div>
        )}

        {activeUnits.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Unit</label>
            <Select
              value={unitId}
              disabled={saving}
              onChange={(event) => setUnitId(event.target.value)}
            >
              {activeUnits.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name}{unit.baseQuantity > 1 ? ` (×${unit.baseQuantity})` : ""}
                </option>
              ))}
            </Select>
          </div>
        )}

        <div>
          <label htmlFor={`${fieldId}-qty`} className="block text-sm font-medium text-slate-700 mb-1">Quantity</label>
          <Input
            id={`${fieldId}-qty`}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="0"
            value={qty || ""}
            onChange={(event) => setQty(toNumber(event.target.value))}
            disabled={saving}
            aria-invalid={qtyError || undefined}
            aria-describedby={qtyError ? `${fieldId}-qty-error` : undefined}
          />
          {qtyError && (
            <p id={`${fieldId}-qty-error`} role="alert" className="mt-1 text-sm font-medium text-rose-700">
              Enter a whole quantity greater than 0.
            </p>
          )}
          {selectedUnit && selectedUnit.baseQuantity > 1 && qty > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              {/* Pre-flight conversion preview — final base delta is computed
                  server-side by `adjust_stock` (migration 028). */}
              {qty} {selectedUnit.name} = {previewBase} {baseUnitName}
            </p>
          )}
        </div>

        <div>
          <label htmlFor={`${fieldId}-reason`} className="block text-sm font-medium text-slate-700 mb-1">
            Reason <span className="text-rose-600" aria-hidden="true">*</span>
          </label>
          <Input
            id={`${fieldId}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Enter reason for adjustment"
            maxLength={REASON_MAX_LENGTH}
            required
            aria-required="true"
            disabled={saving}
            aria-invalid={reasonError || undefined}
            aria-describedby={reasonError ? `${fieldId}-reason-error` : undefined}
          />
          {reasonError && (
            <p id={`${fieldId}-reason-error`} role="alert" className="mt-1 text-sm font-medium text-rose-700">
              A reason is required.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
};
