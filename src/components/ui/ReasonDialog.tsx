import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { REASON_MAX_LENGTH, normalizeReason } from "./reasonInput";

// Required-reason dialog (ORV-013). Replaces `window.prompt()`, which
// Electron does not implement: it returns null at once, so every
// "Enter … reason" action silently did nothing on the desktop app.
//
// The reason is trimmed and must be non-empty before `onConfirm` runs.
// While `onConfirm` is pending the dialog cannot be dismissed or submitted
// twice. If it throws, the dialog stays open with the typed reason so the
// user can retry; the caller reports the error (toast). It closes only
// after `onConfirm` resolves.

interface ReasonDialogProps {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel: string;
  requiredMessage: string;
  /** Destructive actions (reject, cancel) use the danger button. */
  destructive?: boolean;
  onConfirm: (reason: string) => Promise<void> | void;
  onClose: () => void;
}

export const ReasonDialog = ({
  open,
  title,
  description,
  label,
  placeholder,
  confirmLabel,
  cancelLabel,
  requiredMessage,
  destructive = false,
  onConfirm,
  onClose,
}: ReasonDialogProps) => {
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const [reason, setReason] = useState("");
  const [showError, setShowError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous guard: `submitting` only changes on the next render, so two
  // clicks / Enter presses in the same frame would both pass a state check.
  const inFlight = useRef(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // Start empty every time the dialog opens (a new target).
  useEffect(() => {
    if (!open) return;
    setReason("");
    setShowError(false);
    if (!inFlight.current) setSubmitting(false);
  }, [open]);

  const dismiss = () => {
    if (!inFlight.current) onClose();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    const value = normalizeReason(reason);
    if (!value) {
      setShowError(true);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      await onConfirm(value);
      inFlight.current = false;
      onClose();
    } catch {
      // The caller has reported it; keep the reason for a retry and put focus
      // back in the field (the disabled submit button had held it).
      requestAnimationFrame(() => fieldRef.current?.focus());
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const formId = `${fieldId}-form`;
  const invalid = showError && normalizeReason(reason) === null;

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={dismiss}
      size="sm"
      footer={
        <>
          <Button type="button" variant="secondary" onClick={dismiss} disabled={submitting}>
            {cancelLabel}
          </Button>
          <Button type="submit" form={formId} variant={destructive ? "danger" : "primary"} disabled={submitting}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-1">
        <label htmlFor={fieldId} className="block text-sm font-medium text-slate-700">
          {label}
        </label>
        <textarea
          ref={fieldRef}
          id={fieldId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={REASON_MAX_LENGTH}
          autoFocus
          required
          aria-required="true"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          // readOnly, not disabled, while saving: a disabled field drops focus
          // to the page (the shared Modal has no focus trap).
          readOnly={submitting}
          aria-busy={submitting || undefined}
          placeholder={placeholder}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
        />
        {invalid && (
          <p id={errorId} role="alert" className="text-sm font-medium text-rose-700">
            {requiredMessage}
          </p>
        )}
      </form>
    </Modal>
  );
};
