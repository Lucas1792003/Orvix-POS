import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isAppSetupNeeded, useAuthStore } from "../stores/authStore";
import { backendHost } from "../lib/supabase";
import { validateSetupForm } from "../lib/setupValidation";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

// First-time setup: creates the very first administrator (auth account +
// organization + ADMIN row) on a brand-new backend. Operator/installer page,
// English only (like the platform console). It is the ONLY place the app
// creates an auth account for itself; the login page never does (Phase G —
// docs/selfhost-migration/phase-g/login-signup-fix.md).
//
// Reachable only while the server says setup is needed: migration 067's
// app_setup_needed() must return true, both when the page opens and again
// inside bootstrapFirstAdmin() before anything is written. Anything else —
// setup already done, RPC not deployed, network error — renders a
// read-only message with no form.

export type SetupStatusView = "checking" | "needed" | "done" | "unavailable";

export interface SetupViewProps {
  status: SetupStatusView;
  /** Why the status is `unavailable` (never shown as actionable). */
  statusDetail?: string | null;
  backendHost: string;
  email: string;
  confirmEmail: string;
  password: string;
  acknowledged: boolean;
  error: string;
  isSubmitting: boolean;
  onEmailChange: (value: string) => void;
  onConfirmEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onAcknowledgedChange: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/** Pure view — exported so it can be rendered per status in tests. */
export const SetupView = ({
  status, statusDetail, backendHost, email, confirmEmail, password, acknowledged, error, isSubmitting,
  onEmailChange, onConfirmEmailChange, onPasswordChange, onAcknowledgedChange, onSubmit,
}: SetupViewProps) => (
  <div className="min-h-screen flex items-center justify-center p-6">
    <Card className="w-full max-w-xl p-8">
      <div className="text-xs uppercase tracking-[0.3em] text-emerald-700">First-time setup</div>
      <h1 className="mt-2 text-2xl font-semibold text-slate-900">Create the first administrator</h1>
      <p className="mt-2 text-sm text-slate-500">
        Backend: <span className="font-mono text-slate-700" data-testid="setup-backend">{backendHost}</span>
      </p>

      {status === "checking" && (
        <p className="mt-6 text-sm text-slate-500" data-testid="setup-status">Checking whether this backend still needs setup…</p>
      )}

      {status === "done" && (
        <div className="mt-6 space-y-3" data-testid="setup-status">
          <p className="text-sm text-slate-700">
            Setup has already been completed on this backend. There is nothing to do here — staff accounts are
            created by the administrator from the Users page.
          </p>
          <Link to="/login" className="text-sm font-medium text-emerald-700 underline">Go to sign in</Link>
        </div>
      )}

      {status === "unavailable" && (
        <div className="mt-6 space-y-3" data-testid="setup-status">
          <p className="text-sm text-slate-700">
            Could not confirm with the backend whether first-time setup is needed, so nothing can be created
            from here.
          </p>
          {statusDetail && <p className="text-xs text-slate-500">{statusDetail}</p>}
          <Link to="/login" className="text-sm font-medium text-emerald-700 underline">Back to sign in</Link>
        </div>
      )}

      {status === "needed" && (
        <form className="mt-6 space-y-4" onSubmit={onSubmit} autoComplete="off" data-testid="setup-form">
          <p className="text-sm text-slate-600">
            This backend has no staff profiles yet. The account below becomes the only ADMIN of a new
            organization. Type the email twice and confirm before continuing.
          </p>
          <div>
            <label htmlFor="setup-email" className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">Administrator email</label>
            <Input
              id="setup-email"
              type="email"
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div>
            <label htmlFor="setup-email-confirm" className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">Confirm email</label>
            <Input
              id="setup-email-confirm"
              type="email"
              value={confirmEmail}
              onChange={(e) => onConfirmEmailChange(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div>
            <label htmlFor="setup-password" className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">Password</label>
            <Input
              id="setup-password"
              type="password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-1"
              checked={acknowledged}
              onChange={(e) => onAcknowledgedChange(e.target.checked)}
              data-testid="setup-ack"
            />
            <span>
              I understand this creates the first administrator account on <span className="font-mono">{backendHost}</span>.
            </span>
          </label>
          {error && (
            <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}
          <Button className="w-full" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creating administrator…" : "Create administrator"}
          </Button>
          <div className="text-center">
            <Link to="/login" className="text-xs text-slate-500 underline">Back to sign in</Link>
          </div>
        </form>
      )}
    </Card>
  </div>
);

export const SetupPage = () => {
  const navigate = useNavigate();
  const bootstrapFirstAdmin = useAuthStore((state) => state.bootstrapFirstAdmin);
  const [status, setStatus] = useState<SetupStatusView>("checking");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void isAppSetupNeeded().then((result) => {
      if (cancelled) return;
      if (result.error) {
        setStatus("unavailable");
        setStatusDetail(result.error);
      } else {
        setStatus(result.needed ? "needed" : "done");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateSetupForm({ email, confirmEmail, password, acknowledged });
    if (validation) {
      setError(validation);
      return;
    }
    setError("");
    setIsSubmitting(true);
    const result = await bootstrapFirstAdmin(email.trim(), password);
    setIsSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // The first admin has no second factor yet; the verify step decides
    // what it can offer (TOTP enrolment / emailed code).
    navigate("/verify");
  };

  return (
    <SetupView
      status={status}
      statusDetail={statusDetail}
      backendHost={backendHost}
      email={email}
      confirmEmail={confirmEmail}
      password={password}
      acknowledged={acknowledged}
      error={error}
      isSubmitting={isSubmitting}
      onEmailChange={(v) => { setEmail(v); if (error) setError(""); }}
      onConfirmEmailChange={(v) => { setConfirmEmail(v); if (error) setError(""); }}
      onPasswordChange={(v) => { setPassword(v); if (error) setError(""); }}
      onAcknowledgedChange={setAcknowledged}
      onSubmit={(e) => void handleSubmit(e)}
    />
  );
};
