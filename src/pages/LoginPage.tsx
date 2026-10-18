import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isAppSetupNeeded, useAuthStore } from "../stores/authStore";
import { useAppStore } from "../stores/appStore";
import { backendHost } from "../lib/supabase";
import { APP_VERSION, BUILD_LABEL, CAPABILITY_SUMMARY } from "../lib/clientInfo";
import { getTillId } from "../lib/tillId";
import { useSyncStore } from "../stores/syncStore";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useTranslation } from "../hooks/useTranslation";
import { LanguageSwitcher } from "../components/layout/LanguageSwitcher";
import { ExportQueueDialog } from "../components/sync/ExportQueueDialog";
import { useUnresolvedOnlineOperations } from "../hooks/useUnresolvedOnlineOperations";
import { localDb } from "../lib/localDb";

export const LoginPage = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // True only when the server confirmed the install has no users yet
  // (migration 067) — then, and only then, the first-time-setup link is
  // offered. Signing in never creates an account (Phase G).
  const [setupNeeded, setSetupNeeded] = useState(false);
  // Signed out (e.g. after the 24 h offline limit) with sales still queued:
  // the queue is kept, and its encrypted export stays reachable here because
  // signing in needs the server (docs/selfhost-migration/phase-f/queue-export.md).
  const [queuedCount, setQueuedCount] = useState(0);
  // Online-only money operations of unknown outcome (no sign-in: the whole till).
  const unresolvedMoneyOps = useUnresolvedOnlineOperations(null);
  const [quarantinedCount, setQuarantinedCount] = useState(0);
  // On screen only (per-till verification); never sent in any request.
  const tillId = useMemo(() => getTillId(), []);
  const [exportOpen, setExportOpen] = useState(false);
  // Only requests made while this screen is mounted open the dialog.
  useEffect(() => useSyncStore.subscribe((state, prev) => {
    if (state.exportRequestedAt > prev.exportRequestedAt) setExportOpen(true);
  }), []);

  const login = useAuthStore((state) => state.login);
  const setAppShopId = useAppStore((state) => state.setShopId);

  useEffect(() => {
    let cancelled = false;
    void localDb.syncOutbox.count().then((n) => { if (!cancelled) setQueuedCount(n); }).catch(() => undefined);
    void localDb.syncOutbox.where("status").equals("quarantined").count()
      .then((n) => { if (!cancelled) setQuarantinedCount(n); }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void isAppSetupNeeded().then((result) => {
      if (!cancelled) setSetupNeeded(result.needed);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    if (!email.trim() || !password.trim()) {
      setError(t("auth", "emailPasswordRequired"));
      return;
    }

    setIsSubmitting(true);
    const result = await login(email.trim(), password);
    setIsSubmitting(false);

    if (result.error) {
      setError(result.error);
      if (result.setupNeeded) setSetupNeeded(true);
      return;
    }

    if (result.shopId) setAppShopId(result.shopId);

    if (result.role === "ADMIN") {
      // Admins finish on the verify page (which emails + checks the code),
      // unless already verified this browser session.
      navigate(useAuthStore.getState().adminVerified ? "/app/dashboard" : "/verify");
      return;
    }

    navigate("/app");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-5xl overflow-hidden p-0">
        <div className="grid gap-0 md:grid-cols-[1.1fr_1fr]">
          <div className="flex flex-col justify-between bg-emerald-900 p-8 text-white">
            <div>
              <div className="text-xs uppercase tracking-[0.3em] text-emerald-200">{t("auth", "retailPos")}</div>
              <h1 className="mt-3 text-3xl font-semibold">Shwe PhaLar</h1>
              <p className="mt-3 text-sm text-emerald-100">
                {t("auth", "brandTagline")}
              </p>
            </div>
            <div className="mt-10 space-y-1 text-xs text-emerald-100/70">
              <div>{t("auth", "contactAdmin")}</div>
              {/* Which backend this till talks to — visible on every login
                  screen so a mis-targeted build is caught at a glance. */}
              <div className="font-mono" data-testid="login-backend">
                {t("auth", "backendLabel")}: {backendHost}
              </div>
              <div className="font-mono" data-testid="login-client-info">
                v{APP_VERSION}{BUILD_LABEL ? ` ${BUILD_LABEL}` : ""} · {CAPABILITY_SUMMARY}
              </div>
              <div className="font-mono" data-testid="login-till-id">
                {tillId}
              </div>
            </div>
          </div>
          <div className="p-8">
            <div className="mb-4 flex justify-end">
              <LanguageSwitcher />
            </div>
            <div className="text-sm text-slate-500">{t("auth", "signInToAccount")}</div>
            {/* autoComplete off everywhere: this is a shared till, so the
                browser must not cache or auto-fill the previous user's
                credentials. */}
            <form className="mt-6 space-y-4" onSubmit={handleLogin} autoComplete="off">
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">{t("auth", "email")}</div>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (error) setError("");
                  }}
                  placeholder="your@email.com"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  error={!!error}
                />
              </div>
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">{t("auth", "password")}</div>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (error) setError("");
                    }}
                    placeholder={t("auth", "password")}
                    autoComplete="new-password"
                    error={!!error}
                    className="pr-11"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t("auth", "hidePassword") : t("auth", "showPassword")}
                    aria-pressed={showPassword}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 transition-colors hover:text-slate-600"
                  >
                    <span className="material-symbols-rounded text-xl">
                      {showPassword ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
              </div>
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
                >
                  <span className="material-symbols-rounded text-base leading-5">error</span>
                  <span>{error}</span>
                </div>
              )}
              <Button className="w-full" type="submit" disabled={isSubmitting}>
                {isSubmitting ? t("auth", "signingIn") : t("auth", "signIn")}
              </Button>
            </form>
            <div className="mt-6 rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/70 p-4 text-xs text-emerald-700">
              {setupNeeded ? (
                <>
                  {t("auth", "setupNeededHint")}{" "}
                  <Link to="/setup" className="font-medium underline">{t("auth", "setupLink")}</Link>
                </>
              ) : (
                t("auth", "staffCreatedByAdmin")
              )}
            </div>
            {quarantinedCount > 0 && (
              <div role="alert" className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-900" data-testid="login-quarantine">
                {quarantinedCount} {quarantinedCount === 1 ? "transaction was" : "transactions were"} recorded on this till by an older
                app version for a different server and will not be sent from here. Export them and give the file to the owner.
              </div>
            )}
            {unresolvedMoneyOps > 0 && (
              <div role="alert" className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-900" data-testid="login-online-ops-export">
                {unresolvedMoneyOps} {unresolvedMoneyOps === 1 ? "payment or money operation" : "payments or money operations"} on this till
                may already have been applied on the server (the outcome is unknown). Do not enter {unresolvedMoneyOps === 1 ? "it" : "them"} again.{" "}
                <button type="button" className="font-medium underline" onClick={() => setExportOpen(true)}>
                  {t("queueExport", "loginLink")}
                </button>
              </div>
            )}
            {queuedCount > 0 && (
              <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900" data-testid="login-queue-export">
                {t("queueExport", "loginHint", { n: queuedCount })}{" "}
                <button type="button" className="font-medium underline" onClick={() => setExportOpen(true)}>
                  {t("queueExport", "loginLink")}
                </button>
              </div>
            )}
            <ExportQueueDialog open={exportOpen} onClose={() => setExportOpen(false)} />
          </div>
        </div>
      </Card>
    </div>
  );
};
