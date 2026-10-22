import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Role, Sale, Shift } from "../../../types";
import { useAuthStore } from "../../../stores/authStore";
import { useAppStore } from "../../../stores/appStore";
import { useDataStore } from "../../../stores/dataStore";
import { PageHeader } from "../../../components/layout/PageHeader";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Tabs } from "../../../components/ui/Tabs";
import { Select } from "../../../components/ui/Select";
import { Input } from "../../../components/ui/Input";
import { Table, TBody, TD, TH, THead, TR } from "../../../components/ui/Table";
import { useToast } from "../../../components/ui/Toast";
import { ShiftSummary } from "../../../components/shifts/ShiftSummary";
import { StartShiftCard } from "../../../components/shifts/StartShiftCard";
import { EndShiftCard } from "../../../components/shifts/EndShiftCard";
import { buildShiftBreakdown } from "../service";
import { useShiftCash, useShiftReconciliation } from "../../reports/useFinReport";
import { CashMovementsCard } from "../../../components/shifts/CashMovementsCard";
import { checkExpectedBeforeClose, extraReasonError } from "../closeExpected";
import { closeWouldExpect } from "../../reports/finReports";
import {
  buildShiftCsvRows,
  filterShiftRecords,
  getSalesForShift,
  getVisibleShiftsForUser,
  type ShiftStatusFilter,
  validateCloseShift,
} from "../shiftRecords";
import { downloadCsv } from "../../../lib/csv";
import { formatDate, formatDateTime, formatMmk } from "../../../lib/utils";
import { getErrorMessage } from "../../../lib/errors";
import { hasPermission } from "../../../lib/permissions";
import { WorkHoursPanel } from "../components/WorkHoursPanel";
import { formatDuration, getShiftDurationMs } from "../workHours";

const ROLE_TONES: Record<Role, "amber" | "red" | "green" | "blue" | "slate"> = {
  ADMIN: "red",
  MANAGER: "amber",
  CASHIER: "green",
  BUYER: "blue",
};

type TabId = "sales" | "records" | "hours";
type SaleStatusFilter = "all" | Sale["status"];

const statusLabel = (shift: Shift) => (shift.endedAt ? "Closed" : "Open");

const saleStatusTone = (status: Sale["status"]) =>
  status === "NORMAL" ? "green" : status === "VOID" ? "red" : "amber";

export const ShiftsPage = () => {
  const toast = useToast();
  const navigate = useNavigate();
  const currentUserId = useAuthStore((state) => state.currentUserId);
  const currentUser = useDataStore((state) => state.users.find((user) => user.id === currentUserId));
  const { currentShopId } = useAppStore();
  const shops = useDataStore((state) => state.shops);
  const users = useDataStore((state) => state.users);
  const shifts = useDataStore((state) => state.shifts);
  const sales = useDataStore((state) => state.sales);
  const refundVoidRequests = useDataStore((state) => state.refundVoidRequests);
  const startShift = useDataStore((state) => state.startShift);
  const endShift = useDataStore((state) => state.endShift);
  const isLoading = useDataStore((state) => state.isLoading);
  const isLoaded = useDataStore((state) => state.isLoaded);
  const loadError = useDataStore((state) => state.loadError);
  const retryLoadData = useDataStore((state) => state.retryLoadData);

  const [activeTab, setActiveTab] = useState<TabId>("sales");
  const [salesStatusFilter, setSalesStatusFilter] = useState<SaleStatusFilter>("all");
  const [openingCash, setOpeningCash] = useState(0);
  const [closingCash, setClosingCash] = useState<number | undefined>(undefined);
  const [varianceReason, setVarianceReason] = useState("");
  const [closeAttempted, setCloseAttempted] = useState(false);
  const [recordsMonthFilter, setRecordsMonthFilter] = useState<string>("all");
  const [recordsStatusFilter, setRecordsStatusFilter] = useState<ShiftStatusFilter>("all");
  const [recordsShopFilter, setRecordsShopFilter] = useState<string>("all");
  const [recordsUserFilter, setRecordsUserFilter] = useState<string>("all");

  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(handle);
  }, []);

  const role = currentUser?.role;
  const canOpenOwn = hasPermission(currentUser, "shift:manage_own");
  const selectedAdminShopId =
    role === "ADMIN" && currentShopId && shops.some((shop) => shop.id === currentShopId)
      ? currentShopId
      : "";
  const personalShopId = currentUser
    ? role === "ADMIN"
      ? selectedAdminShopId
      : currentUser.shopId ?? ""
    : "";
  const personalShop = shops.find((shop) => shop.id === personalShopId);
  const personalShopMissing = !personalShopId;

  const visibleShifts = useMemo(
    () => getVisibleShiftsForUser(shifts, currentUser),
    [shifts, currentUser]
  );

  const ownOpenShift = useMemo(
    () => (currentUser ? shifts.find((shift) => shift.cashierId === currentUser.id && !shift.endedAt) : undefined),
    [shifts, currentUser]
  );

  const activeShiftSales = useMemo(
    () => (ownOpenShift ? getSalesForShift(sales, ownOpenShift.id) : []),
    [sales, ownOpenShift]
  );

  const activeBreakdown = useMemo(
    () => (ownOpenShift ? buildShiftBreakdown(ownOpenShift, activeShiftSales, refundVoidRequests) : null),
    [ownOpenShift, activeShiftSales, refundVoidRequests]
  );

  // Expected cash for the close form: the server reconciliation of the open
  // shift (every approved refund, whoever entered it) when it answers;
  // otherwise this device's estimate from loaded sales, labelled as such.
  const ownRecon = useShiftReconciliation(ownOpenShift?.id ?? null);
  // Step 4 (PFIN-D): on a server with cash movements / split payments, ITS expected cash (fin_shift_cash) is the one
  // the close uses; the PFIN-B figure (which cannot see movements) is used only on a server without PFIN-D.
  const [cashNonce, setCashNonce] = useState(0);
  const ownCash = useShiftCash(ownOpenShift && !ownOpenShift.pendingSync ? ownOpenShift.id : null, cashNonce);
  const pfinD = !(ownCash.state.status === "unavailable" && ownCash.state.reason === "NOT_INSTALLED") && ownCash.state.status !== "idle";
  const ownServerExpected = pfinD
    ? (ownCash.state.status === "ok" ? ownCash.state.data.expectedCashMmk : null)
    : ownRecon.state.status === "ok" ? closeWouldExpect(ownRecon.state.data) : null;
  const ownCloseExpected = ownServerExpected ?? activeBreakdown?.expectedCash ?? 0;

  const baseActiveValidation = activeBreakdown
    ? validateCloseShift({
        closingCash,
        expectedCash: ownCloseExpected,
        varianceReason,
      })
    : { variance: null, canClose: false, error: null };
  const activeDeviceReasonError = baseActiveValidation.canClose
    ? extraReasonError({ closingCash, shownExpectedMmk: ownCloseExpected, deviceExpectedMmk: activeBreakdown?.expectedCash, varianceReason })
    : null;
  const activeCloseValidation = activeDeviceReasonError
    ? { ...baseActiveValidation, canClose: false, error: activeDeviceReasonError }
    : baseActiveValidation;

  const handleStartShift = async () => {
    if (!currentUser) return;
    if (ownOpenShift) {
      toast({
        title: "Shift already open",
        description: "Close your current shift before opening another one.",
        variant: "error",
      });
      return;
    }
    if (!personalShopId) {
      toast({
        title: "Select a shop first",
        description:
          role === "ADMIN"
            ? "Pick a shop from the switcher before opening a shift."
            : "Contact your administrator. Your account is not assigned to a shop.",
        variant: "error",
      });
      return;
    }
    if (!Number.isFinite(openingCash) || openingCash < 0) {
      toast({ title: "Invalid opening cash", description: "Opening cash must be zero or greater.", variant: "error" });
      return;
    }

    try {
      await startShift({
        shopId: personalShopId,
        cashierId: currentUser.id,
        openingCashMmk: openingCash,
      });
      toast({ title: "Shift opened", variant: "success" });
      setOpeningCash(0);
    } catch (error) {
      toast({
        title: "Could not open shift",
        description: getErrorMessage(error, "Failed to open shift."),
        variant: "error",
      });
    }
  };

  const handleEndOwnShift = async () => {
    if (!ownOpenShift || !activeBreakdown) return;
    if (ownRecon.state.status === "loading" || ownCash.state.status === "loading") {
      toast({ title: "Checking expected cash", description: "The server reconciliation is still loading. Try again in a moment.", variant: "error" });
      return;
    }
    setCloseAttempted(true);
    if (!activeCloseValidation.canClose) {
      toast({
        title: "Cannot close shift",
        description: activeCloseValidation.error ?? "Check the closing cash fields.",
        variant: "error",
      });
      return;
    }

    const check = await checkExpectedBeforeClose(ownOpenShift.id, ownCloseExpected);
    if (!check.proceed) {
      ownRecon.refresh();
      toast({
        title: "Expected cash changed",
        description: `The server now expects ${formatMmk(check.latestMmk)} (a refund or void was approved meanwhile). Check the count and close again.`,
        variant: "error",
      });
      return;
    }
    try {
      await endShift({
        shiftId: ownOpenShift.id,
        closingCashMmk: closingCash ?? 0,
        // a typed reason is always sent: the server's own variance may differ from the form's
        varianceReason: varianceReason.trim() !== "" ? varianceReason.trim() : undefined,
      });
      toast({ title: "Shift closed", variant: "success" });
      setClosingCash(undefined);
      setVarianceReason("");
      setCloseAttempted(false);
    } catch (error) {
      toast({
        title: "Could not close shift",
        description: getErrorMessage(error, "Failed to close shift."),
        variant: "error",
      });
    }
  };

  const recordsShopOptions = useMemo(() => {
    if (role !== "ADMIN") return [];
    return shops
      .filter((shop) => shop.isActive || visibleShifts.some((shift) => shift.shopId === shop.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [role, shops, visibleShifts]);

  const recordsUserScopeShifts = useMemo(() => {
    if (role === "ADMIN" && recordsShopFilter !== "all") {
      return visibleShifts.filter((shift) => shift.shopId === recordsShopFilter);
    }
    return visibleShifts;
  }, [role, visibleShifts, recordsShopFilter]);

  const recordsUserOptions = useMemo(() => {
    if (role !== "ADMIN" && role !== "MANAGER") return [];
    const seen = new Set<string>();
    const opts: { id: string; name: string }[] = [];
    for (const shift of recordsUserScopeShifts) {
      if (seen.has(shift.cashierId)) continue;
      seen.add(shift.cashierId);
      const user = users.find((item) => item.id === shift.cashierId);
      opts.push({ id: shift.cashierId, name: user?.name ?? "Unknown user" });
    }
    return opts.sort((a, b) => a.name.localeCompare(b.name));
  }, [recordsUserScopeShifts, users, role]);

  const filteredRecords = useMemo(
    () =>
      filterShiftRecords(visibleShifts, {
        month: recordsMonthFilter,
        status: recordsStatusFilter,
        shopId: role === "ADMIN" ? recordsShopFilter : "all",
        userId: role === "ADMIN" || role === "MANAGER" ? recordsUserFilter : "all",
      }),
    [visibleShifts, recordsMonthFilter, recordsStatusFilter, recordsShopFilter, recordsUserFilter, role]
  );

  const exportShifts = () => {
    downloadCsv(
      "shifts.csv",
      buildShiftCsvRows(filteredRecords, users, shops, sales, refundVoidRequests, now)
    );
  };

  // Sales Records tab — every sale in scope, filtered by the same
  // month/shop/user controls plus a sale-status filter. Scope mirrors the
  // Sales page: ADMIN sees all, `sale:view` holders see their shop, others
  // see only the sales they rang up.
  const visibleSales = useMemo(() => {
    if (!currentUser) return [];
    if (role === "ADMIN") return sales;
    if (hasPermission(currentUser, "sale:view")) {
      return sales.filter((sale) => sale.shopId === currentUser.shopId);
    }
    return sales.filter((sale) => sale.cashierId === currentUser.id);
  }, [sales, currentUser, role]);

  const filteredSales = useMemo(() => {
    return visibleSales
      .filter((sale) => {
        if (recordsMonthFilter !== "all" && sale.createdAt.slice(0, 7) !== recordsMonthFilter) return false;
        if (role === "ADMIN" && recordsShopFilter !== "all" && sale.shopId !== recordsShopFilter) return false;
        if (
          (role === "ADMIN" || role === "MANAGER") &&
          recordsUserFilter !== "all" &&
          sale.cashierId !== recordsUserFilter
        )
          return false;
        if (salesStatusFilter !== "all" && sale.status !== salesStatusFilter) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [visibleSales, recordsMonthFilter, recordsShopFilter, recordsUserFilter, salesStatusFilter, role]);

  const salesTotal = useMemo(
    () => filteredSales.reduce((sum, sale) => sum + (sale.status === "NORMAL" ? sale.totalMmk : 0), 0),
    [filteredSales]
  );

  // Group sales into per-day sections so the list isn't one mixed blob.
  const salesByDay = useMemo(() => {
    const groups = new Map<string, typeof filteredSales>();
    for (const sale of filteredSales) {
      const day = sale.createdAt.slice(0, 10);
      const bucket = groups.get(day);
      if (bucket) bucket.push(sale);
      else groups.set(day, [sale]);
    }
    return [...groups.entries()].map(([day, daySales]) => ({
      day,
      sales: daySales,
      normalTotal: daySales.reduce((sum, s) => sum + (s.status === "NORMAL" ? s.totalMmk : 0), 0),
    }));
  }, [filteredSales]);

  const exportSales = () => {
    downloadCsv(
      "sales.csv",
      filteredSales.map((sale) => ({
        receiptNo: sale.receiptNo,
        createdAt: sale.createdAt,
        cashier: users.find((user) => user.id === sale.cashierId)?.name ?? sale.cashierId,
        shop: shops.find((shop) => shop.id === sale.shopId)?.name ?? sale.shopId,
        paymentMethod: sale.paymentMethod,
        status: sale.status,
        totalMmk: sale.totalMmk,
      }))
    );
  };

  const renderShell = (body: ReactNode) => (
    <Card>
      <PageHeader
        title="Shifts"
        subtitle="Open or close shifts, review cashier sessions, and check work hours."
      />
      <div className="mt-6">{body}</div>
    </Card>
  );

  if (isLoading && !isLoaded) {
    return renderShell(
      <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-6 text-sm text-slate-500">
        Loading shifts...
      </div>
    );
  }

  if (loadError) {
    return renderShell(
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">
        <div className="font-semibold">Could not load shift data.</div>
        <div className="mt-1">{loadError}</div>
        <Button className="mt-4" variant="secondary" onClick={retryLoadData}>
          Retry
        </Button>
      </div>
    );
  }

  if (!currentUser) {
    return renderShell(
      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-sm text-slate-500">
        No signed-in user was found.
      </div>
    );
  }

  if (!canOpenOwn) {
    return renderShell(
      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-sm text-slate-500">
        You do not have permission to access shifts.
      </div>
    );
  }

  return (
    <Card>
      <PageHeader
        title="Shifts"
        subtitle="Open or close shifts, review cashier sessions, and check work hours."
        actions={
          activeTab === "records" && filteredRecords.length > 0 ? (
            <Button variant="secondary" onClick={exportShifts}>
              Export CSV
            </Button>
          ) : activeTab === "sales" && filteredSales.length > 0 ? (
            <Button variant="secondary" onClick={exportSales}>
              Export CSV
            </Button>
          ) : undefined
        }
      />

      <div className="mt-6 rounded-2xl border border-slate-200/70 bg-slate-50/40 p-4">
        {ownOpenShift && activeBreakdown ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Active shift</div>
                <div className="mt-1 text-base font-semibold text-slate-900">{currentUser.name}</div>
                <div className="mt-1 text-sm text-slate-600">
                  {shops.find((shop) => shop.id === ownOpenShift.shopId)?.name ?? ownOpenShift.shopId}
                  {" - "}
                  started {formatDateTime(ownOpenShift.startedAt)}
                </div>
              </div>
              <Badge tone="green" className="tabular-nums">
                Open - {formatDuration(getShiftDurationMs(ownOpenShift, now))}
              </Badge>
            </div>

            <ShiftSummary shift={ownOpenShift} breakdown={activeBreakdown} />

            {!ownOpenShift.pendingSync ? (
              <CashMovementsCard
                shiftId={ownOpenShift.id}
                cash={ownCash.state}
                canManage={hasPermission(currentUser, "shift:manage_all")}
                onChanged={() => setCashNonce((n) => n + 1)}
              />
            ) : null}

            <div className="text-xs text-slate-500" data-close-expected-source={ownServerExpected !== null ? "server" : "device"}>
              {ownServerExpected !== null
                ? "Expected cash from the server reconciliation (every approved refund). The backend recomputes it on close."
                : ownRecon.state.status === "loading"
                  ? "Loading the server reconciliation…"
                  : "Server reconciliation unavailable: expected cash is this device's estimate from loaded sales. The backend recomputes it on close."}
            </div>
            <EndShiftCard
              idPrefix="own-shift"
              closingCash={closingCash}
              expectedCash={ownCloseExpected}
              varianceReason={varianceReason}
              onVarianceReasonChange={setVarianceReason}
              onClosingCashChange={(next) => {
                setClosingCash(next);
                setCloseAttempted(false);
              }}
              onEnd={handleEndOwnShift}
              error={closeAttempted ? activeCloseValidation.error : null}
            />
          </div>
        ) : personalShopMissing ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-600">
            {role === "ADMIN" ? (
              <>Select a shop to open a shift. Pick one from the shop switcher at the top of the page.</>
            ) : (
              <>Your account is not assigned to a shop. Contact your administrator.</>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm text-slate-600">
              No active shift. Open one for{" "}
              <span className="font-semibold text-slate-800">{personalShop?.name ?? personalShopId}</span>.
            </div>
            <StartShiftCard
              openingCash={openingCash}
              onOpeningCashChange={setOpeningCash}
              onStart={handleStartShift}
            />
          </div>
        )}
      </div>

      <div className="mt-6">
        <Tabs
          tabs={[
            { id: "sales", label: "Sales Records" },
            { id: "records", label: "Shift Records" },
            { id: "hours", label: "Work Hours" },
          ]}
          active={activeTab}
          onChange={(id) => setActiveTab(id as TabId)}
        />
      </div>

      {activeTab === "sales" && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Month</label>
              <Input
                type="month"
                value={recordsMonthFilter === "all" ? "" : recordsMonthFilter}
                onChange={(event) => setRecordsMonthFilter(event.target.value || "all")}
                className="w-40"
              />
            </div>
            {recordsMonthFilter !== "all" && (
              <Button variant="secondary" onClick={() => setRecordsMonthFilter("all")}>
                All dates
              </Button>
            )}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</label>
              <Select
                value={salesStatusFilter}
                onChange={(event) => setSalesStatusFilter(event.target.value as SaleStatusFilter)}
                className="w-40"
              >
                <option value="all">All</option>
                <option value="NORMAL">Normal</option>
                <option value="VOID">Void</option>
                <option value="REFUNDED">Refunded</option>
              </Select>
            </div>
            {role === "ADMIN" && (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Shop</label>
                <Select
                  value={recordsShopFilter}
                  onChange={(event) => {
                    setRecordsShopFilter(event.target.value);
                    setRecordsUserFilter("all");
                  }}
                  className="w-48"
                >
                  <option value="all">All shops</option>
                  {recordsShopOptions.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {(role === "ADMIN" || role === "MANAGER") && (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium uppercase tracking-wide text-slate-500">User</label>
                <Select
                  value={recordsUserFilter}
                  onChange={(event) => setRecordsUserFilter(event.target.value)}
                  className="w-52"
                >
                  <option value="all">All users</option>
                  {recordsUserOptions.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="ml-auto rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-right text-xs text-slate-500">
              <div>
                {filteredSales.length} sale{filteredSales.length === 1 ? "" : "s"}
              </div>
              <div className="font-semibold text-slate-700">{formatMmk(salesTotal)}</div>
            </div>
          </div>

          {visibleSales.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
              No sales are available for your role.
            </div>
          ) : filteredSales.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
              No sales match the selected filters.
            </div>
          ) : (
            <div className="space-y-6">
              {salesByDay.map((group) => (
                <div key={group.day} className="space-y-2">
                  <div className="flex items-center justify-between px-1">
                    <div className="text-sm font-semibold text-slate-700">{formatDate(group.day)}</div>
                    <div className="text-xs text-slate-500">
                      {group.sales.length} sale{group.sales.length === 1 ? "" : "s"} · {formatMmk(group.normalTotal)}
                    </div>
                  </div>
                  <div className="overflow-x-auto rounded-2xl border border-slate-200/70 bg-white">
                    <Table className="min-w-[860px]">
                      <THead>
                        <TR>
                          <TH>Receipt</TH>
                          <TH>Time</TH>
                          <TH>Cashier</TH>
                          <TH>Shop</TH>
                          <TH>Payment</TH>
                          <TH>Status</TH>
                          <TH className="text-right">Total</TH>
                          <TH></TH>
                        </TR>
                      </THead>
                      <TBody>
                        {group.sales.map((sale) => (
                          <TR key={sale.id}>
                            <TD className="font-mono text-xs">{sale.receiptNo}</TD>
                            <TD className="text-xs text-slate-600">{formatDateTime(sale.createdAt)}</TD>
                            <TD>{users.find((user) => user.id === sale.cashierId)?.name ?? "Unknown user"}</TD>
                            <TD>{shops.find((shop) => shop.id === sale.shopId)?.name ?? sale.shopId}</TD>
                            <TD>{sale.paymentMethod}</TD>
                            <TD>
                              <Badge tone={saleStatusTone(sale.status)}>{sale.status}</Badge>
                            </TD>
                            <TD className="text-right tabular-nums">{formatMmk(sale.totalMmk)}</TD>
                            <TD className="text-right">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => navigate(`/app/sales/${sale.id}`)}
                              >
                                View
                              </Button>
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "records" && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Month</label>
              <Input
                type="month"
                value={recordsMonthFilter === "all" ? "" : recordsMonthFilter}
                onChange={(event) => setRecordsMonthFilter(event.target.value || "all")}
                className="w-40"
              />
            </div>
            {recordsMonthFilter !== "all" && (
              <Button variant="secondary" onClick={() => setRecordsMonthFilter("all")}>
                All dates
              </Button>
            )}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</label>
              <Select
                value={recordsStatusFilter}
                onChange={(event) => setRecordsStatusFilter(event.target.value as ShiftStatusFilter)}
                className="w-36"
              >
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </Select>
            </div>
            {role === "ADMIN" && (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Shop</label>
                <Select
                  value={recordsShopFilter}
                  onChange={(event) => {
                    setRecordsShopFilter(event.target.value);
                    setRecordsUserFilter("all");
                  }}
                  className="w-48"
                >
                  <option value="all">All shops</option>
                  {recordsShopOptions.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {(role === "ADMIN" || role === "MANAGER") && (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium uppercase tracking-wide text-slate-500">User</label>
                <Select
                  value={recordsUserFilter}
                  onChange={(event) => setRecordsUserFilter(event.target.value)}
                  className="w-52"
                >
                  <option value="all">All users</option>
                  {recordsUserOptions.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="ml-auto flex items-center self-stretch rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              {filteredRecords.length} shift{filteredRecords.length === 1 ? "" : "s"}
            </div>
          </div>

          {visibleShifts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
              No shift records are available for your role.
            </div>
          ) : filteredRecords.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-sm text-slate-500">
              No shift records match the selected filters.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200/70 bg-white">
              <Table className="min-w-[1180px]">
                <THead>
                  <TR>
                    <TH>Cashier</TH>
                    <TH>Role</TH>
                    <TH>Shop</TH>
                    <TH>Start</TH>
                    <TH>End</TH>
                    <TH>Duration</TH>
                    <TH className="text-right">Sales</TH>
                    <TH className="text-right">Expected cash</TH>
                    <TH className="text-right">Closing cash</TH>
                    <TH className="text-right">Variance</TH>
                    <TH>Status</TH>
                    <TH></TH>
                  </TR>
                </THead>
                <TBody>
                  {filteredRecords.map((shift) => {
                    const user = users.find((item) => item.id === shift.cashierId);
                    const shop = shops.find((item) => item.id === shift.shopId);
                    const rowSales = getSalesForShift(sales, shift.id);
                    const breakdown = buildShiftBreakdown(shift, rowSales, refundVoidRequests);
                    const isClosed = !!shift.endedAt;

                    return (
                      <TR key={shift.id}>
                        <TD>{user?.name ?? "Unknown user"}</TD>
                        <TD>
                          <Badge tone={ROLE_TONES[user?.role ?? "CASHIER"]}>{user?.role ?? "CASHIER"}</Badge>
                        </TD>
                        <TD>{shop?.name ?? shift.shopId}</TD>
                        <TD className="text-xs text-slate-600">{formatDateTime(shift.startedAt)}</TD>
                        <TD className="text-xs text-slate-600">
                          {shift.endedAt ? formatDateTime(shift.endedAt) : "Active"}
                        </TD>
                        <TD className="tabular-nums">{formatDuration(getShiftDurationMs(shift, now))}</TD>
                        <TD className="text-right tabular-nums">{breakdown.salesCount}</TD>
                        <TD className="text-right tabular-nums" title={isClosed ? "Stored at close" : "Device estimate from loaded sales; open the shift for the server reconciliation"}>
                          {isClosed ? formatMmk(shift.expectedCashMmk ?? breakdown.expectedCash) : `≈ ${formatMmk(breakdown.expectedCash)}`}
                        </TD>
                        <TD className="text-right tabular-nums">
                          {isClosed ? formatMmk(shift.closingCashMmk ?? 0) : "Active"}
                        </TD>
                        <TD className="text-right tabular-nums">
                          {isClosed ? formatMmk(shift.varianceMmk ?? 0) : "Active"}
                        </TD>
                        <TD>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={isClosed ? "slate" : "green"}>{statusLabel(shift)}</Badge>
                            {shift.pendingSync && <Badge tone="amber">Pending sync</Badge>}
                          </div>
                        </TD>
                        <TD className="text-right">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => navigate(`/app/shifts/${shift.id}`)}
                          >
                            View
                          </Button>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {activeTab === "hours" && (
        <div className="mt-5">
          <WorkHoursPanel
            shifts={visibleShifts}
            users={users}
            shops={shops}
            viewerRole={currentUser.role}
            viewerAssignedShopId={currentUser.shopId}
            now={now}
          />
        </div>
      )}

    </Card>
  );
};
