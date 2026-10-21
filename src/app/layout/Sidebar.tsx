import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { useAppStore } from "../../stores/appStore";
import { useDataStore } from "../../stores/dataStore";
import { cn } from "../../lib/utils";
import { backendHost } from "../../lib/supabase";
import { APP_VERSION, BUILD_LABEL, CAPABILITY_SUMMARY } from "../../lib/clientInfo";
import { getTillId } from "../../lib/tillId";

// On screen only (per-till verification); never sent in any request.
const TILL_ID = getTillId();
import type { Permission, Role } from "../../types";
import { hasPermission, ROUTE_PERMISSIONS } from "../../lib/permissions";
import { ShopSwitcher } from "./ShopSwitcher";
import { LanguageSwitcher } from "../../components/layout/LanguageSwitcher";
import { ThemeToggle } from "../../components/layout/ThemeToggle";
import { DownloadAppModal } from "../../components/layout/DownloadAppModal";
import { CheckForUpdatesButton } from "../../components/layout/CheckForUpdatesButton";
import { useTranslation } from "../../hooks/useTranslation";
import { useViewportWidth } from "../../hooks/useViewportWidth";

interface NavItem {
  to: string;
  labelKey: string;
  permission: Permission;
  icon: string;
  /** Optional role gate layered on top of the permission. The route guard
   * checks this too — see AppRouter. */
  allowedRoles?: Role[];
  /** Match the path exactly, so `/app/reports` is not also highlighted on
   *  `/app/reports/profit`. */
  end?: boolean;
}

interface NavSection {
  titleKey?: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    // Main navigation - no title
    items: [
      { to: "/app/dashboard", labelKey: "dashboard", permission: ROUTE_PERMISSIONS.dashboard, icon: "dashboard" },
      { to: "/app/pos", labelKey: "pos", permission: ROUTE_PERMISSIONS.pos, icon: "point_of_sale" },
    ],
  },
  {
    titleKey: "salesOperations",
    items: [
      { to: "/app/sales", labelKey: "salesHistory", permission: ROUTE_PERMISSIONS.sales, icon: "receipt_long" },
      { to: "/app/shifts", labelKey: "shifts", permission: ROUTE_PERMISSIONS.shifts, icon: "schedule" },
      { to: "/app/approvals", labelKey: "approvals", permission: ROUTE_PERMISSIONS.approvals, icon: "fact_check" },
      { to: "/app/barcode-labels", labelKey: "barcodeLabels", permission: ROUTE_PERMISSIONS.barcodeLabels, icon: "qr_code_2", allowedRoles: ["ADMIN", "MANAGER"] },
      // Reports (ORV-012): routed but had no menu entry, so unreachable on
      // the desktop app (no address bar). Gated exactly like their routes.
      // `/app/admin/reports` (Global Reports) is not listed: it renders the
      // same shop-scoped ReportsPage as `/app/reports` until ORV-035 gives
      // it a real all-shops view.
      { to: "/app/reports", labelKey: "reports", permission: ROUTE_PERMISSIONS.reports, icon: "bar_chart", end: true },
      { to: "/app/reports/profit", labelKey: "profitReports", permission: ROUTE_PERMISSIONS.reportsProfit, icon: "trending_up" },
    ],
  },
  {
    // Catalog (Products) lives here with the stock operations it relates to,
    // not under Administration.
    titleKey: "inventorySection",
    items: [
      { to: "/app/inventory", labelKey: "inventory", permission: ROUTE_PERMISSIONS.inventory, icon: "inventory_2" },
      { to: "/app/admin/products", labelKey: "products", permission: ROUTE_PERMISSIONS.adminProducts, icon: "inventory", allowedRoles: ["ADMIN", "MANAGER"] },
      // Read-only catalogue for roles without the Products page (BUYER is
      // redirected here on sign-in but could not navigate back) — ORV-012.
      { to: "/app/catalog", labelKey: "catalog", permission: ROUTE_PERMISSIONS.catalog, icon: "menu_book", allowedRoles: ["CASHIER", "BUYER"] },
      { to: "/app/admin/unit-types", labelKey: "unitTypes", permission: ROUTE_PERMISSIONS.adminUnitTypes, icon: "straighten" },
      { to: "/app/admin/pricing", labelKey: "pricing", permission: ROUTE_PERMISSIONS.adminPricing, icon: "sell" },
      { to: "/app/admin/barcodes", labelKey: "barcodes", permission: ROUTE_PERMISSIONS.adminBarcodes, icon: "barcode" },
      { to: "/app/transfers", labelKey: "transfers", permission: ROUTE_PERMISSIONS.transfers, icon: "swap_horiz" },
      { to: "/app/purchases", labelKey: "purchases", permission: ROUTE_PERMISSIONS.purchases, icon: "local_shipping" },
      { to: "/app/suppliers", labelKey: "suppliers", permission: ROUTE_PERMISSIONS.suppliers, icon: "handshake" },
    ],
  },
  {
    // Store administration + the Settings hub (Security/authenticator tab).
    titleKey: "administration",
    items: [
      { to: "/app/admin/shops", labelKey: "shops", permission: ROUTE_PERMISSIONS.adminShops, icon: "store" },
      { to: "/app/admin/users", labelKey: "users", permission: ROUTE_PERMISSIONS.adminUsers, icon: "group" },
      { to: "/app/admin/audit", labelKey: "auditLog", permission: ROUTE_PERMISSIONS.adminAudit, icon: "policy" },
      { to: "/app/admin/sync-conflicts", labelKey: "syncConflicts", permission: ROUTE_PERMISSIONS.adminSyncConflicts, icon: "sync_problem" },
      { to: "/app/profile", labelKey: "profile", permission: ROUTE_PERMISSIONS.adminSecurity, icon: "storefront", allowedRoles: ["ADMIN"] },
      { to: "/app/security", labelKey: "security", permission: ROUTE_PERMISSIONS.adminSecurity, icon: "shield_lock", allowedRoles: ["ADMIN"] },
    ],
  },
];

const SIDEBAR_COLLAPSED_KEY = "retails-shop.sidebarCollapsed";

const readSidebarCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
};

export const Sidebar = () => {
  const navigate = useNavigate();
  const { currentUserId, logout } = useAuthStore();
  const setShopId = useAppStore((state) => state.setShopId);
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const businessProfile = useDataStore((state) => state.businessProfile);
  const brandName = businessProfile?.businessName?.trim() || "Shwe PhaLar";
  const brandLogo = businessProfile?.logoUrl?.trim() || `${import.meta.env.BASE_URL}logo_real.png`;
  const brandMeta = businessProfile?.tagline?.trim() || "Multi-shop console";
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(readSidebarCollapsed);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const { t } = useTranslation();
  const viewportWidth = useViewportWidth();
  const isTabletNav = viewportWidth < 1024;
  const effectiveCollapsed = isTabletNav || isSidebarCollapsed;

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(isSidebarCollapsed));
    } catch {
      // Ignore storage failures; the toggle still works for this session.
    }
  }, [isSidebarCollapsed]);

  const toggleSection = (title: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(title)) {
        next.delete(title);
      } else {
        next.add(title);
      }
      return next;
    });
  };

  const handleLogout = () => {
    logout();
    setShopId(null);
    navigate("/login");
  };

  return (
    <aside className={cn("sidebar print-hidden", effectiveCollapsed && "sidebar-collapsed")}>
      <div className="sidebar-header">
        {/* mix-blend-multiply is a safety net: if the PNG has a white
            background it blends into the sidebar's white panel; if it
            is already transparent the blend mode is a no-op. */}
        <img
          src={brandLogo}
          alt={`${brandName} logo`}
          className="header-logo mix-blend-multiply"
        />
        <div className="sidebar-brand-copy">
          <div className="shopName">{brandName}</div>
          <div className="shop-meta">{brandMeta}</div>
        </div>
        {!isTabletNav && (
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setIsSidebarCollapsed((value) => !value)}
            aria-label={isSidebarCollapsed ? "Open sidebar" : "Close sidebar"}
            title={isSidebarCollapsed ? "Open sidebar" : "Close sidebar"}
          >
            <span className="material-symbols-rounded">
              {isSidebarCollapsed ? "keyboard_double_arrow_right" : "keyboard_double_arrow_left"}
            </span>
          </button>
        )}
      </div>

      <div className="sidebar-content">
        <div className="sidebar-shop">
          <ShopSwitcher />
        </div>

        <nav className="nav">
          {navSections.map((section, sectionIndex) => {
            // Filter items by permission AND optional role gate.
            const visibleItems = section.items.filter((item) => {
              if (!hasPermission(currentUser, item.permission)) return false;
              if (item.allowedRoles && currentUser && !item.allowedRoles.includes(currentUser.role)) return false;
              return true;
            });

            // Skip section if no visible items.
            if (visibleItems.length === 0) return null;

            const sectionTitle = section.titleKey ? t("sidebar", section.titleKey) : undefined;
            const isCollapsed = sectionTitle ? collapsedSections.has(sectionTitle) : false;
            const showItems = isSidebarCollapsed || !isCollapsed;

            return (
              <div key={section.titleKey || `section-${sectionIndex}`} className="nav-section">
                {sectionTitle && !effectiveCollapsed && (
                  <button
                    type="button"
                    className="section-header"
                    onClick={() => toggleSection(sectionTitle)}
                  >
                    <span className="section-title">{sectionTitle}</span>
                    <span className={cn("material-symbols-rounded section-arrow", isCollapsed && "collapsed")}>
                      expand_more
                    </span>
                  </button>
                )}
                {showItems && (
                  <ul className="menu-list">
                    {visibleItems.map((item) => (
                      <li key={item.to} className="menu-item">
                        <NavLink
                          to={item.to}
                          end={item.end}
                          className={({ isActive }) => cn("menu-link", isActive && "active")}
                          title={effectiveCollapsed ? t("sidebar", item.labelKey) : undefined}
                        >
                          <span className="material-symbols-rounded">{item.icon}</span>
                          <span className="menu-label">{t("sidebar", item.labelKey)}</span>
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-footer-top">
          <LanguageSwitcher className="sidebar-language" />
          <ThemeToggle />
        </div>
        <div className="sidebar-user">
          <div className="user-name">{currentUser?.name ?? "User"}</div>
          <div className="user-role">{currentUser?.role ?? ""}</div>
          {/* Which backend this till talks to (Phase G): shown next to the
              user so a mis-targeted build is visible from any screen. */}
          <div className="sidebar-backend" title={`Backend: ${backendHost}`} data-testid="sidebar-backend">
            backend: {backendHost}
          </div>
          <div
            className="sidebar-backend"
            title={`Orvix POS ${APP_VERSION} · ${CAPABILITY_SUMMARY}`}
            data-testid="sidebar-client-info"
          >
            v{APP_VERSION}{BUILD_LABEL ? ` ${BUILD_LABEL}` : ""} · {CAPABILITY_SUMMARY}
          </div>
          <div className="sidebar-backend" title={`Till id: ${TILL_ID}`} data-testid="sidebar-till-id">
            {TILL_ID}
          </div>
        </div>
        <div className="sidebar-footer-actions">
          {!window.electronAPI && (
            <button
              type="button"
              className="logout-btn"
              onClick={() => setShowDownloadModal(true)}
              title={effectiveCollapsed ? "Download desktop app" : undefined}
              aria-label="Download desktop app"
            >
              <span className="material-symbols-rounded">download</span>
              <span>Download App</span>
            </button>
          )}
          <CheckForUpdatesButton />
          <button
            type="button"
            className="logout-btn footer-logout-icon"
            onClick={handleLogout}
            title={t("common", "logout")}
            aria-label={t("common", "logout")}
          >
            <span className="material-symbols-rounded">logout</span>
            <span>{t("common", "logout")}</span>
          </button>
        </div>
      </div>
      <DownloadAppModal open={showDownloadModal} onClose={() => setShowDownloadModal(false)} />
    </aside>
  );
};
