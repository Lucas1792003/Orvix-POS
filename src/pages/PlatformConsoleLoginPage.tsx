import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { usePlatformAuthStore } from "../stores/platformAuthStore";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

// Deliberately distinct from LoginPage.tsx — different visual language
// (slate/graphite, not the emerald product brand) so this can never be
// mistaken for the real product login. Not linked from anywhere in the
// app; reached only by typing/bookmarking /console/login.
export const PlatformConsoleLoginPage = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const login = usePlatformAuthStore((s) => s.login);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!email.trim() || !password.trim()) {
      setError("Email and password are required.");
      return;
    }

    setIsSubmitting(true);
    const result = await login(email.trim(), password);
    setIsSubmitting(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    navigate("/console");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-6">
      <Card className="w-full max-w-md p-8">
        <div className="text-xs uppercase tracking-[0.3em] text-slate-400">Internal Console</div>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Platform admin</h1>
        <p className="mt-2 text-sm text-slate-500">
          Restricted to platform operators. This is not the shop login.
        </p>
        <form className="mt-6 space-y-4" onSubmit={handleLogin} autoComplete="off">
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">Email</div>
            <Input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError("");
              }}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              error={!!error}
            />
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">Password</div>
            <Input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError("");
              }}
              autoComplete="new-password"
              error={!!error}
            />
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
            {isSubmitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
};
