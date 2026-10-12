import { useMemo, useState } from "react";
import { useDataStore } from "../stores/dataStore";
import { supabase } from "../lib/supabase";
import type { Role } from "../types";
import { PageHeader } from "../components/layout/PageHeader";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { Button } from "../components/ui/Button";
import { mapUserFormError, USER_FORM_MESSAGES } from "../features/admin/userFormErrors";

export const UsersPage = () => {
  const users = useDataStore((state) => state.users);
  const shops = useDataStore((state) => state.shops);
  const addUser = useDataStore((state) => state.addUser);
  const updateUser = useDataStore((state) => state.updateUser);
  const deactivateUser = useDataStore((state) => state.deactivateUser);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("CASHIER");
  const [shopId, setShopId] = useState<string | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Pre-compute the maps the form needs to render correctly:
  //   * existingAdmin       — if present, ADMIN cannot be picked as a new role
  //   * managerByShop       — for the CASHIER picker hint and the MANAGER lock
  // Inactive rows are ignored; uniqueness rules in 020 treat them as gone.
  const existingAdmin = useMemo(
    () => users.find((u) => u.role === "ADMIN"),
    [users],
  );
  const managerByShop = useMemo(() => {
    const map: Record<string, { id: string; name: string }> = {};
    for (const u of users) {
      if (u.role === "MANAGER" && u.isActive && u.shopId) {
        map[u.shopId] = { id: u.id, name: u.name };
      }
    }
    return map;
  }, [users]);

  // Every non-admin role is bound to a single shop. BUYER is a per-shop
  // purchasing role: its `purchase:create` / `purchase:view` permissions are
  // shop-scoped by RLS, so a shopless BUYER would be unable to do anything.
  const requiresShop = role !== "ADMIN";

  // Hide ADMIN as a creatable role once an admin exists. When editing, the
  // existing admin keeps the option; everyone else loses it so they can't
  // be promoted into a second admin row.
  const adminAlreadyExists = !!existingAdmin;
  const editingAdminSelf = !!editingId && existingAdmin?.id === editingId;
  const showAdminOption = !adminAlreadyExists || editingAdminSelf;

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setEmail("");
    setPassword("");
    setRole("CASHIER");
    setShopId(undefined);
    setFeedback(null);
  };

  // Shop options for the current role. Each shop gets a disabled flag and an
  // explanation so the picker can render a single Select with grouped state.
  const shopOptions = useMemo(() => {
    return shops.map((shop) => {
      const manager = managerByShop[shop.id];
      if (role === "MANAGER") {
        // Block shops that already have an ACTIVE manager OTHER than the row
        // being edited. The row being edited can keep its current shop.
        const otherManager = manager && manager.id !== editingId;
        return {
          id: shop.id,
          label: otherManager
            ? `${shop.name} · Manager: ${manager?.name}`
            : shop.name,
          disabled: !!otherManager,
          hint: otherManager
            ? "This shop already has a manager. Deactivate or reassign the existing manager first."
            : undefined,
        };
      }
      if (role === "CASHIER") {
        return {
          id: shop.id,
          label: manager ? `${shop.name} · Manager: ${manager.name}` : shop.name,
          disabled: !manager,
          hint: manager ? undefined : "No active manager assigned",
        };
      }
      // BUYER and any other shop-scoped role: no manager dependency.
      return { id: shop.id, label: shop.name, disabled: false, hint: undefined };
    });
  }, [shops, managerByShop, role, editingId]);

  // Pre-submit validation that mirrors the DB rules so users don't have to
  // round-trip just to see "this shop already has a manager". The DB stays
  // the source of truth — anything that slips past us still throws there.
  const validateBeforeSubmit = (): string | null => {
    if (!name.trim()) return "Name is required.";
    if (role === "ADMIN" && adminAlreadyExists && !editingAdminSelf) {
      return USER_FORM_MESSAGES.secondAdmin;
    }
    if (role === "MANAGER") {
      if (!shopId) return USER_FORM_MESSAGES.managerWithoutShop;
      const m = managerByShop[shopId];
      if (m && m.id !== editingId) return USER_FORM_MESSAGES.secondManager;
    }
    if (role === "CASHIER") {
      if (!shopId) return USER_FORM_MESSAGES.cashierWithoutShop;
      if (!managerByShop[shopId]) return USER_FORM_MESSAGES.cashierWithoutManager;
    }
    if (role === "BUYER" && !shopId) return USER_FORM_MESSAGES.buyerWithoutShop;
    return null;
  };

  const handleSubmit = async () => {
    const preflight = validateBeforeSubmit();
    if (preflight) { setFeedback({ type: "error", message: preflight }); return; }

    if (editingId) {
      const existing = users.find((u) => u.id === editingId)!;
      setIsSubmitting(true);
      try {
        await updateUser({
          ...existing,
          name: name.trim(),
          role,
          shopId: requiresShop ? shopId : undefined,
        });
        setFeedback({ type: "success", message: "User updated." });
        // Keep the modal in place on success of an edit so the operator
        // can verify the change in the side list before dismissing.
      } catch (error) {
        setFeedback({ type: "error", message: mapUserFormError(error) });
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    // Create new user
    if (!email.trim()) { setFeedback({ type: "error", message: "Email is required." }); return; }
    if (password.length < 6) { setFeedback({ type: "error", message: "Password must be at least 6 characters." }); return; }

    const alreadyExists = users.some((u) => u.email === email.trim());
    if (alreadyExists) { setFeedback({ type: "error", message: "A user with this email already exists." }); return; }

    setIsSubmitting(true);
    setFeedback(null);

    // Preserve the admin's session — supabase.auth.signUp() signs the browser
    // in as the new user, which would make the users-table insert run as the
    // new (unprivileged) user and fail RLS.
    const { data: { session: adminSession } } = await supabase.auth.getSession();

    // Create the Supabase Auth account.
    const signUpResult = await supabase.auth.signUp({
      email: email.trim(),
      password,
    });

    if (signUpResult.error && !signUpResult.error.message.includes("already registered")) {
      setIsSubmitting(false);
      setFeedback({ type: "error", message: `Auth error: ${signUpResult.error.message}` });
      return;
    }

    // Restore the admin session so the users-table insert runs as the admin.
    if (adminSession) {
      await supabase.auth.setSession({
        access_token: adminSession.access_token,
        refresh_token: adminSession.refresh_token,
      });
    }

    // Create user record in our users table, linked to the new auth account.
    const newAuthId = signUpResult.data.user?.id;
    const userId = `user-${email.trim().replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;
    try {
      await addUser({
        id: userId,
        name: name.trim(),
        email: email.trim().toLowerCase(),
        role,
        shopId: requiresShop ? shopId : undefined,
        authId: newAuthId,
      });
    } catch (error) {
      setIsSubmitting(false);
      setFeedback({ type: "error", message: mapUserFormError(error) });
      // Modal stays open on failure so the operator can fix the input
      // (e.g. pick a different shop) and resubmit without re-entering everything.
      return;
    }

    setIsSubmitting(false);
    // resetForm() clears the feedback too, so set the success message after
    // it (otherwise the confirmation is wiped the moment it is shown).
    const createdName = name;
    const createdEmail = email;
    resetForm();
    setFeedback({ type: "success", message: `${createdName} created. They can now log in with ${createdEmail}.` });
  };

  const handleEdit = (id: string) => {
    const user = users.find((item) => item.id === id);
    if (!user) return;
    setEditingId(id);
    setName(user.name);
    setEmail(user.email ?? "");
    setPassword("");
    setRole(user.role);
    setShopId(user.shopId);
    setFeedback(null);
  };

  // Editing an existing user into MANAGER for a shop that already has a
  // different active manager — normal submit blocks this (secondManager
  // validation) since two active managers can't coexist. This is the
  // atomic swap escape hatch instead of the old manual two-step dance
  // (see 05-roles-permissions.md "Manager replacement").
  const replaceManager = useDataStore((state) => state.replaceManager);
  const currentShopManager = shopId ? managerByShop[shopId] : undefined;
  const canReplaceManager =
    Boolean(editingId) && role === "MANAGER" && Boolean(shopId) &&
    Boolean(currentShopManager) && currentShopManager?.id !== editingId;

  const handleReplaceManager = async () => {
    if (!editingId || !shopId) return;
    setIsSubmitting(true);
    setFeedback(null);
    try {
      await replaceManager(shopId, editingId);
      setFeedback({ type: "success", message: `${name || "User"} is now the manager of this shop.` });
      resetForm();
    } catch (error) {
      setFeedback({ type: "error", message: mapUserFormError(error) });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleActive = async (id: string) => {
    const user = users.find((u) => u.id === id);
    if (!user) return;
    try {
      await deactivateUser(user.id, !user.isActive);
    } catch (error) {
      setFeedback({ type: "error", message: mapUserFormError(error) });
    }
  };

  // Hint for the currently picked shop (used to render the inline warning
  // under the shop select so disabled rows aren't just silently un-pickable).
  const selectedShopHint = useMemo(() => {
    if (!shopId) return undefined;
    return shopOptions.find((opt) => opt.id === shopId)?.hint;
  }, [shopOptions, shopId]);

  return (
    <Card>
      <PageHeader
        title="Users"
        subtitle="Create staff accounts and assign roles. Staff log in with the email and password you set here."
      />
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <div className="text-sm font-semibold text-slate-700">
            {editingId ? "Edit user" : "Create staff account"}
          </div>

          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
          />

          {!editingId && (
            <>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="staff@yourcompany.com"
                autoComplete="off"
              />
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password (min 6 characters)"
                autoComplete="new-password"
              />
            </>
          )}

          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {showAdminOption && <option value="ADMIN">Admin</option>}
            <option value="MANAGER">Manager</option>
            <option value="CASHIER">Cashier</option>
            <option value="BUYER">Buyer</option>
          </Select>
          {adminAlreadyExists && !editingAdminSelf && (
            <div className="text-xs text-slate-400">
              Admin role is reserved for the existing admin
              {existingAdmin?.name ? ` (${existingAdmin.name})` : ""}.
            </div>
          )}

          {requiresShop && (
            <>
              <Select value={shopId ?? ""} onChange={(e) => setShopId(e.target.value || undefined)}>
                <option value="">Select a shop</option>
                {shopOptions.map((opt) => (
                  <option key={opt.id} value={opt.id} disabled={opt.disabled}>
                    {opt.label}
                    {opt.disabled ? " (unavailable)" : ""}
                  </option>
                ))}
              </Select>
              {selectedShopHint && (
                <div className="text-xs text-amber-600">{selectedShopHint}</div>
              )}
              {role === "CASHIER" && shops.length > 0 && Object.keys(managerByShop).length === 0 && (
                <div className="text-xs text-amber-600">
                  No shop has an active manager yet. Create a manager first.
                </div>
              )}
            </>
          )}

          {feedback && (
            <div className={`text-sm rounded-xl px-3 py-2 ${feedback.type === "success" ? "bg-emerald-50 text-emerald-700" : "text-rose-600"}`}>
              {feedback.message}
            </div>
          )}

          {canReplaceManager && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {currentShopManager?.name} is already the manager of this shop. Use
              "Replace manager" below to swap them out atomically instead of
              deactivating them first.
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSubmit} disabled={isSubmitting || canReplaceManager}>
              {isSubmitting ? "Creating…" : editingId ? "Update" : "Create account"}
            </Button>
            {canReplaceManager && (
              <Button variant="secondary" onClick={handleReplaceManager} disabled={isSubmitting}>
                Replace manager
              </Button>
            )}
            {editingId && (
              <Button variant="secondary" onClick={resetForm}>Cancel</Button>
            )}
          </div>

          {!editingId && (
            <div className="rounded-2xl border border-dashed border-slate-200 p-3 text-xs text-slate-400">
              Make sure email confirmation is disabled in Supabase → Auth → Settings, otherwise staff need to confirm their email before logging in.
            </div>
          )}
        </div>

        <div className="space-y-3">
          {users.map((user) => (
            <div
              key={user.id}
              className={`rounded-2xl border p-4 ${user.isActive ? "border-slate-200/70 bg-slate-50/60" : "border-slate-100 bg-slate-50/30 opacity-60"}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-sm">{user.name}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{user.email ?? "—"}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    {user.role}
                    {user.shopId ? ` · ${shops.find((s) => s.id === user.shopId)?.name ?? user.shopId}` : ""}
                    {!user.isActive && " · Inactive"}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  <Button variant="secondary" className="text-xs py-1 px-2" onClick={() => handleEdit(user.id)}>
                    Edit
                  </Button>
                  <Button
                    variant={user.isActive ? "danger" : "secondary"}
                    className="text-xs py-1 px-2"
                    onClick={() => handleToggleActive(user.id)}
                  >
                    {user.isActive ? "Disable" : "Enable"}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
};
