import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { isBackdropDismiss, isEscapeDismiss, type ModalCloseDetail, type ModalCloseReason } from "./modalDismiss";

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  /** Called with why the modal asked to close (Escape, backdrop, X). */
  onClose: (reason: ModalCloseReason, detail: ModalCloseDetail) => void;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}

const sizes: Record<string, string> = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-3xl",
  xl: "max-w-6xl",
};

export const Modal = ({ open, title, description, onClose, children, footer, size = "md" }: ModalProps) => {
  // Did the current press start on the backdrop? (see isBackdropDismiss)
  const pressOnBackdrop = useRef(false);
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (isEscapeDismiss(event)) onClose("escape", { trusted: event.isTrusted });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-3 backdrop-blur-sm md:p-4"
      onMouseDown={(e) => {
        pressOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Close when clicking the backdrop (a press that started there too)
        const dismiss = isBackdropDismiss(pressOnBackdrop.current, e.target, e.currentTarget);
        pressOnBackdrop.current = false;
        if (dismiss) onClose("backdrop", { trusted: e.isTrusted });
      }}
    >
      <div
        className={cn(
          "flex max-h-[calc(100dvh-1.5rem)] w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-2xl md:max-h-[calc(100dvh-2rem)]",
          sizes[size]
        )}
      >
        {/* Fixed Header */}
        <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-slate-100 p-4 md:p-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={(e) => onClose("x-button", { trusted: e.isTrusted })}
            className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <span className="material-symbols-rounded text-xl">close</span>
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
          <div className="space-y-4">{children}</div>
        </div>

        {/* Fixed Footer */}
        {footer && (
          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-3 border-t border-slate-100 p-4 md:p-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
