import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import type { Permission, Role } from "../../../types";
import { useAuthStore } from "../../../stores/authStore";
import { useDataStore } from "../../../stores/dataStore";
import { hasPermission } from "../../../lib/permissions";

interface RequireRoleProps {
  allowed?: Role[];
  permission?: Permission;
  children: ReactNode;
}

export const RequireRole = ({ allowed, permission, children }: RequireRoleProps) => {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const isLoading = useDataStore((state) => state.isLoading);
  const isLoaded = useDataStore((state) => state.isLoaded);

  if (!currentUserId) return <Navigate to="/login" replace />;
  // The store renders from the local cache first, and that cache is the
  // PREVIOUS user's view of `users` — it may not contain whoever just
  // signed in on this till until the network load lands. Redirecting here
  // would bounce a valid sign-in to /login (Phase E finding); wait instead.
  // Not loaded yet for this sign-in (login() resets the mirror; AppLayout's
  // effect starts the load after this render): wait, don't bounce.
  if (!currentUser && (isLoading || !isLoaded)) return <GuardFallback />;
  if (!currentUser) return <Navigate to="/login" replace />;
  if (allowed && !allowed.includes(currentUser.role)) return <Navigate to="/app" replace />;
  if (permission && !hasPermission(currentUser, permission)) return <Navigate to="/app" replace />;
  return <>{children}</>;
};

const GuardFallback = () => (
  <div className="flex h-full items-center justify-center p-8 text-sm text-slate-500">
    Loading…
  </div>
);
