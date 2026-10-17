import { useEffect } from "react";
import { cn } from "../../lib/utils";
import { useToastStore } from "../../stores/toastStore";

export const useToast = () => {
  const addToast = useToastStore((state) => state.addToast);
  return addToast;
};

export const ToastViewport = () => {
  const toasts = useToastStore((state) => state.toasts);
  const removeToast = useToastStore((state) => state.removeToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    // A warning (e.g. "pending confirmation") stays long enough to be read.
    const timers = toasts.map((toast) => setTimeout(() => removeToast(toast.id), toast.variant === "warning" ? 9000 : 3200));
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [toasts, removeToast]);

  return (
    <div className="fixed right-6 top-6 z-50 space-y-3 print-hidden">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.variant === "warning" ? "alert" : undefined}
          className={cn(
            "w-80 rounded-2xl border p-4 text-sm shadow-2xl",
            // A warning ("pending confirmation") must not look like success.
            toast.variant === "warning" ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white",
            toast.variant === "success" && "border-emerald-200",
            toast.variant === "error" && "border-rose-200"
          )}
        >
          <div className={cn("font-semibold", toast.variant === "warning" ? "text-amber-900" : "text-slate-900")}>{toast.title}</div>
          {toast.description && <div className={cn("mt-1", toast.variant === "warning" ? "text-amber-800" : "text-slate-500")}>{toast.description}</div>}
        </div>
      ))}
    </div>
  );
};
