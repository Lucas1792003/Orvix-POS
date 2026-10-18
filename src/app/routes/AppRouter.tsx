import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "../layout/AppLayout";
import { RequireAuth } from "./guards/RequireAuth";
import { RequireRole } from "./guards/RequireRole";
import { LoginPage } from "../../features/auth/pages/LoginPage";
import { AdminVerifyPage } from "../../features/auth/pages/AdminVerifyPage";
import { ProfilePage } from "../../features/admin/pages/ProfilePage";
import { SecurityPage } from "../../features/auth/pages/SecurityPage";
import { PosPage } from "../../features/pos/pages/PosPage";
import { SalesListPage } from "../../features/sales/pages/SalesListPage";
import { SaleDetailPage } from "../../features/sales/pages/SaleDetailPage";
import { ShiftsPage } from "../../features/shifts/pages/ShiftsPage";
import { ShiftDetailPage } from "../../features/shifts/pages/ShiftDetailPage";
import { InventoryPage } from "../../features/inventory/pages/InventoryPage";
import { TransfersPage } from "../../features/transfers/pages/TransfersPage";
import { PurchasesPage } from "../../features/purchases/pages/PurchasesPage";
import { ApprovalsPage } from "../../features/approvals/pages/ApprovalsPage";
import { SupplierDetailPage } from "../../pages/SupplierDetailPage";
import { CatalogPage } from "../../features/catalog/pages/CatalogPage";
import { DashboardPage } from "../../pages/DashboardPage";
import { BarcodeLabelsPage } from "../../pages/BarcodeLabelsPage";
import { PhoneProductImageUploadPage } from "../../pages/PhoneProductImageUploadPage";
import { NotFoundPage } from "../../pages/NotFoundPage";
import { SetupPage } from "../../pages/SetupPage";
import { useAuthStore } from "../../stores/authStore";
import { useDataStore } from "../../stores/dataStore";
import { ROUTE_PERMISSIONS } from "../../lib/permissions";

// Lazy-loaded: admin pages, reports, and the product form. These are the
// least-frequently-visited routes, so they shouldn't add to the first-paint
// bundle for POS/dashboard/login, which stay eager below.
const ShopReportsPage = lazy(() =>
  import("../../features/reports/pages/ShopReportsPage").then((m) => ({ default: m.ShopReportsPage })),
);
const GlobalReportsPage = lazy(() =>
  import("../../features/reports/pages/GlobalReportsPage").then((m) => ({ default: m.GlobalReportsPage })),
);
const ProfitReportsPage = lazy(() =>
  import("../../features/reports/pages/ProfitReportsPage").then((m) => ({ default: m.ProfitReportsPage })),
);
const ShopsAdminPage = lazy(() =>
  import("../../features/admin/pages/ShopsAdminPage").then((m) => ({ default: m.ShopsAdminPage })),
);
const UsersAdminPage = lazy(() =>
  import("../../features/admin/pages/UsersAdminPage").then((m) => ({ default: m.UsersAdminPage })),
);
const ProductsAdminPage = lazy(() =>
  import("../../features/admin/pages/ProductsAdminPage").then((m) => ({ default: m.ProductsAdminPage })),
);
const ProductFormPage = lazy(() =>
  import("../../pages/ProductFormPage").then((m) => ({ default: m.ProductFormPage })),
);
const UnitTypesAdminPage = lazy(() =>
  import("../../features/admin/pages/UnitTypesAdminPage").then((m) => ({ default: m.UnitTypesAdminPage })),
);
const BarcodesAdminPage = lazy(() =>
  import("../../features/admin/pages/BarcodesAdminPage").then((m) => ({ default: m.BarcodesAdminPage })),
);
const SuppliersPage = lazy(() =>
  import("../../features/admin/pages/SuppliersPage").then((m) => ({ default: m.SuppliersPage })),
);
const PricingPage = lazy(() =>
  import("../../features/admin/pages/PricingPage").then((m) => ({ default: m.PricingPage })),
);
const AuditLogPage = lazy(() =>
  import("../../features/admin/pages/AuditLogPage").then((m) => ({ default: m.AuditLogPage })),
);
const SyncConflictsPage = lazy(() =>
  import("../../pages/SyncConflictsPage").then((m) => ({ default: m.SyncConflictsPage })),
);
const MyUnresolvedOperationsPage = lazy(() =>
  import("../../pages/MyUnresolvedOperationsPage").then((m) => ({ default: m.MyUnresolvedOperationsPage })),
);
const PlatformConsoleLoginPage = lazy(() =>
  import("../../pages/PlatformConsoleLoginPage").then((m) => ({ default: m.PlatformConsoleLoginPage })),
);
const PlatformConsolePage = lazy(() =>
  import("../../pages/PlatformConsolePage").then((m) => ({ default: m.PlatformConsolePage })),
);

const DefaultAppRoute = () => {
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const isLoading = useDataStore((state) => state.isLoading);
  const isLoaded = useDataStore((state) => state.isLoaded);
  // Same guard as RequireRole: the cache-first render may predate this
  // user's row; wait for the in-flight load before deciding.
  // Not loaded yet for this sign-in (login() resets the mirror; AppLayout's
  // effect starts the load after this render): wait, don't bounce.
  if (!currentUser && (isLoading || !isLoaded)) return <RouteFallback />;
  if (!currentUser) return <Navigate to="/login" replace />;
  if (currentUser.role === "BUYER") return <Navigate to="/app/catalog" replace />;
  return <Navigate to="/app/pos" replace />;
};

// Matches AppLayout's existing plain-text bootstrap loading style — no new
// spinner component for a chunk fetch that's typically well under a second.
const RouteFallback = () => (
  <div className="flex h-full items-center justify-center p-8 text-sm text-slate-500">
    Loading…
  </div>
);

export const AppRouter = () => (
  <Suspense fallback={<RouteFallback />}>
    <Routes>
      <Route path="/phone-upload/product-image/:token" element={<PhoneProductImageUploadPage />} />
      <Route path="/login" element={<LoginPage />} />
      {/* First-time setup (Phase G): the explicit first-admin bootstrap.
          Public route, but the page itself only acts when the server's
          app_setup_needed() (migration 067) confirms the install is empty. */}
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/verify" element={<AdminVerifyPage />} />
      {/* Internal platform-admin console — not linked from anywhere in the
          app (no nav, no link on /login). Own auth (platformAuthStore),
          own Edge Function (platform-console), never touches authStore,
          RequireAuth, or AppLayout's data loading. */}
      <Route path="/console/login" element={<PlatformConsoleLoginPage />} />
      <Route path="/console" element={<PlatformConsolePage />} />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DefaultAppRoute />} />
        <Route
          path="dashboard"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.dashboard}>
              <DashboardPage />
            </RequireRole>
          }
        />
        <Route
          path="pos"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.pos}>
              <PosPage />
            </RequireRole>
          }
        />
        <Route
          path="sales"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.sales}>
              <SalesListPage />
            </RequireRole>
          }
        />
        <Route
          path="sales/:saleId"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.saleDetail}>
              <SaleDetailPage />
            </RequireRole>
          }
        />
        <Route
          path="shifts"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.shifts}>
              <ShiftsPage />
            </RequireRole>
          }
        />
        <Route
          path="shifts/:shiftId"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.shifts}>
              <ShiftDetailPage />
            </RequireRole>
          }
        />
        <Route
          path="inventory"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.inventory}>
              <InventoryPage />
            </RequireRole>
          }
        />
        <Route
          path="transfers"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.transfers}>
              <TransfersPage />
            </RequireRole>
          }
        />
        <Route
          path="purchases"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.purchases}>
              <PurchasesPage />
            </RequireRole>
          }
        />
        <Route
          path="approvals"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.approvals}>
              <ApprovalsPage />
            </RequireRole>
          }
        />
        <Route
          path="reports"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.reports}>
              <ShopReportsPage />
            </RequireRole>
          }
        />
        <Route
          path="reports/profit"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.reportsProfit}>
              <ProfitReportsPage />
            </RequireRole>
          }
        />
        <Route
          path="catalog"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.catalog}>
              <CatalogPage />
            </RequireRole>
          }
        />
        <Route
          path="barcode-labels"
          element={
            <RequireRole allowed={["ADMIN", "MANAGER"]} permission={ROUTE_PERMISSIONS.barcodeLabels}>
              <BarcodeLabelsPage />
            </RequireRole>
          }
        />
        <Route
          path="suppliers"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.suppliers}>
              <SuppliersPage />
            </RequireRole>
          }
        />
        <Route
          path="suppliers/:supplierId"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.supplierDetail}>
              <SupplierDetailPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/shops"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.adminShops}>
              <ShopsAdminPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/users"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.adminUsers}>
              <UsersAdminPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/products"
          element={
            <RequireRole allowed={["ADMIN", "MANAGER"]} permission={ROUTE_PERMISSIONS.adminProducts}>
              <ProductsAdminPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/products/new"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.adminProductCreate}>
              <ProductFormPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/products/:productId/edit"
          element={
            <RequireRole allowed={["ADMIN", "MANAGER"]} permission={ROUTE_PERMISSIONS.adminProductEdit}>
              <ProductFormPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/unit-types"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.adminUnitTypes}>
              <UnitTypesAdminPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/barcodes"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.adminBarcodes}>
              <BarcodesAdminPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/suppliers"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.adminSuppliers}>
              <SuppliersPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/pricing"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.adminPricing}>
              <PricingPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/reports"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.adminReports}>
              <GlobalReportsPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/audit"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.adminAudit}>
              <AuditLogPage />
            </RequireRole>
          }
        />
        <Route
          path="sync/unresolved"
          element={
            // Any signed-in user, OWN operations only (no permission grants
            // anything here beyond what re-entering the payment already allows).
            <RequireRole>
              <MyUnresolvedOperationsPage />
            </RequireRole>
          }
        />
        <Route
          path="admin/sync-conflicts"
          element={
            <RequireRole permission={ROUTE_PERMISSIONS.adminSyncConflicts}>
              <SyncConflictsPage />
            </RequireRole>
          }
        />
        <Route
          path="profile"
          element={
            <RequireRole allowed={["ADMIN"]} permission={ROUTE_PERMISSIONS.adminSecurity}>
              <ProfilePage />
            </RequireRole>
          }
        />
        <Route
          path="security"
          element={
            <RequireRole allowed={["ADMIN"]} permission={ROUTE_PERMISSIONS.adminSecurity}>
              <SecurityPage />
            </RequireRole>
          }
        />
        {/* Old Settings hub removed; send any stale link to Profile. */}
        <Route path="settings" element={<Navigate to="/app/profile" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  </Suspense>
);
