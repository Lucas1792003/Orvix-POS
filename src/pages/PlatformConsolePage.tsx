import { useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { usePlatformAuthStore, callPlatformConsole } from "../stores/platformAuthStore";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

interface OrgRow {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  adminName: string | null;
  adminEmail: string | null;
  shopCount: number;
}

// Self-guarded like AdminVerifyPage.tsx: no session / failed whoami ->
// redirect to /console/login. No Sidebar/AppLayout, no useDataStore —
// this page never touches the org-scoped data pipeline.
export const PlatformConsolePage = () => {
  const adminProfile = usePlatformAuthStore((s) => s.adminProfile);
  const isLoading = usePlatformAuthStore((s) => s.isLoading);
  const restore = usePlatformAuthStore((s) => s.restore);
  const logout = usePlatformAuthStore((s) => s.logout);

  const [restored, setRestored] = useState(false);
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [orgsError, setOrgsError] = useState("");

  const [orgName, setOrgName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [orgFormError, setOrgFormError] = useState("");
  const [newOrgResult, setNewOrgResult] = useState<{ orgId: string; adminEmail: string; tempPassword: string } | null>(null);

  const [newAdminName, setNewAdminName] = useState("");
  const [newAdminEmail, setNewAdminEmail] = useState("");
  const [creatingAdmin, setCreatingAdmin] = useState(false);
  const [adminFormError, setAdminFormError] = useState("");
  const [newAdminResult, setNewAdminResult] = useState<{ email: string; tempPassword: string } | null>(null);

  const loadOrgs = async () => {
    setOrgsError("");
    const { data, error } = await callPlatformConsole<{ organizations: OrgRow[] }>({ action: "list_organizations" });
    if (error || !data) {
      setOrgsError(error ?? "Could not load organizations.");
      return;
    }
    setOrgs(data.organizations);
  };

  useEffect(() => {
    void (async () => {
      await restore();
      setRestored(true);
      if (usePlatformAuthStore.getState().adminProfile) await loadOrgs();
    })();
  }, [restore]);

  if (!restored || isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400">Loading...</div>;
  }
  if (!adminProfile) {
    return <Navigate to="/console/login" replace />;
  }

  const handleCreateOrg = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setOrgFormError("");
    setNewOrgResult(null);
    if (!orgName.trim() || !adminName.trim() || !adminEmail.trim()) {
      setOrgFormError("Organization name, admin name, and admin email are required.");
      return;
    }
    setCreatingOrg(true);
    const { data, error } = await callPlatformConsole<{ orgId: string; adminEmail: string; tempPassword: string }>({
      action: "create_organization",
      orgName: orgName.trim(),
      adminName: adminName.trim(),
      adminEmail: adminEmail.trim(),
    });
    setCreatingOrg(false);
    if (error || !data) {
      setOrgFormError(error ?? "Could not create the organization.");
      return;
    }
    setNewOrgResult(data);
    setOrgName("");
    setAdminName("");
    setAdminEmail("");
    void loadOrgs();
  };

  const handleCreateAdmin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAdminFormError("");
    setNewAdminResult(null);
    if (!newAdminName.trim() || !newAdminEmail.trim()) {
      setAdminFormError("Name and email are required.");
      return;
    }
    setCreatingAdmin(true);
    const { data, error } = await callPlatformConsole<{ email: string; tempPassword: string }>({
      action: "create_platform_admin",
      name: newAdminName.trim(),
      email: newAdminEmail.trim(),
    });
    setCreatingAdmin(false);
    if (error || !data) {
      setAdminFormError(error ?? "Could not create the platform admin.");
      return;
    }
    setNewAdminResult(data);
    setNewAdminName("");
    setNewAdminEmail("");
  };

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Internal Console</div>
            <h1 className="mt-1 text-xl font-semibold text-white">Platform admin</h1>
            <p className="text-sm text-slate-400">Signed in as {adminProfile.name} ({adminProfile.email})</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>

        <Card className="p-6">
          <h2 className="text-sm font-semibold text-slate-900">Organizations</h2>
          {orgsError && <div className="mt-2 text-sm text-rose-600">{orgsError}</div>}
          {orgs === null && !orgsError && <div className="mt-2 text-sm text-slate-500">Loading...</div>}
          {orgs !== null && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">Admin</th>
                    <th className="py-2 pr-4">Shops</th>
                    <th className="py-2 pr-4">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {orgs.map((o) => (
                    <tr key={o.id} className="border-b border-slate-100">
                      <td className="py-2 pr-4 text-slate-900">{o.name}</td>
                      <td className="py-2 pr-4 text-slate-600">
                        {o.adminName ? `${o.adminName} (${o.adminEmail})` : "—"}
                      </td>
                      <td className="py-2 pr-4 text-slate-600">{o.shopCount}</td>
                      <td className="py-2 pr-4 text-slate-500">{new Date(o.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                  {orgs.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-4 text-center text-slate-400">No organizations yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="text-sm font-semibold text-slate-900">Create organization</h2>
          <form className="mt-3 grid gap-3 sm:grid-cols-3" onSubmit={handleCreateOrg}>
            <Input placeholder="Organization name" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
            <Input placeholder="Admin name" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
            <Input placeholder="Admin email" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            <div className="sm:col-span-3">
              <Button type="submit" disabled={creatingOrg}>
                {creatingOrg ? "Creating..." : "Create organization"}
              </Button>
            </div>
          </form>
          {orgFormError && <div className="mt-3 text-sm text-rose-600">{orgFormError}</div>}
          {newOrgResult && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              Created. Temp password for {newOrgResult.adminEmail} (shown once — copy it now):{" "}
              <code className="font-mono">{newOrgResult.tempPassword}</code>
            </div>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="text-sm font-semibold text-slate-900">Add platform admin</h2>
          <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={handleCreateAdmin}>
            <Input placeholder="Name" value={newAdminName} onChange={(e) => setNewAdminName(e.target.value)} />
            <Input placeholder="Email" type="email" value={newAdminEmail} onChange={(e) => setNewAdminEmail(e.target.value)} />
            <div className="sm:col-span-2">
              <Button type="submit" disabled={creatingAdmin}>
                {creatingAdmin ? "Creating..." : "Add platform admin"}
              </Button>
            </div>
          </form>
          {adminFormError && <div className="mt-3 text-sm text-rose-600">{adminFormError}</div>}
          {newAdminResult && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              Created. Temp password for {newAdminResult.email} (shown once — copy it now):{" "}
              <code className="font-mono">{newAdminResult.tempPassword}</code>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};
