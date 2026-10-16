import { useEffect, useState } from "react";
import type { ElectronUpdateGuardDecision } from "../../types/electron";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { useSyncStore } from "../../stores/syncStore";
import { drainOutbox } from "../../stores/data/outbox";
import { APP_VERSION } from "../../lib/clientInfo";

type Phase = "idle" | "checking" | "downloading" | "downloaded" | "waiting" | "not-available" | "error";

const ICONS: Record<Phase, string> = {
  idle: "system_update",
  checking: "sync",
  downloading: "sync",
  downloaded: "restart_alt",
  waiting: "schedule",
  "not-available": "check_circle",
  error: "error",
};

/**
 * Sidebar update control. An update that is downloaded but held back by
 * the install guard (electron/updateGuard.cjs: unsynced sales, offline,
 * signed out, sale in progress) shows "Waiting"; clicking it explains why
 * and offers "Export pending", "Sync now" and the owner's recovery path
 * ("Install anyway", only after an export; main asks for confirmation).
 */
export const CheckForUpdatesButton = () => {
  const [version, setVersion] = useState<string | null>(null);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<ElectronUpdateGuardDecision | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    void api.appVersion().then(setVersion);

    return api.onUpdateStatus((status) => {
      switch (status.state) {
        case "checking":
          setPhase("checking");
          break;
        case "available":
          setPhase("downloading");
          setPercent(0);
          break;
        case "downloading":
          setPhase("downloading");
          setPercent(status.percent ?? 0);
          break;
        case "downloaded":
          if (status.version) setUpdateVersion(status.version);
          if (status.blocked) {
            setBlocked(status.blocked);
            setPhase("waiting");
          } else {
            setBlocked(null);
            setPhase("downloaded");
          }
          break;
        case "not-available":
          setPhase("not-available");
          break;
        case "error":
          setPhase("error");
          setMessage(status.message ?? "Update check failed.");
          break;
      }
    });
  }, []);

  // Auto-reset transient statuses so the button returns to "Check for
  // Updates" instead of getting stuck on "Up to date" / "Check failed".
  useEffect(() => {
    if (phase !== "not-available" && phase !== "error") return;
    const timer = setTimeout(() => setPhase("idle"), 4000);
    return () => clearTimeout(timer);
  }, [phase]);

  if (!window.electronAPI) return null;

  const busy = phase === "checking" || phase === "downloading";

  const install = async () => {
    const result = await window.electronAPI?.installUpdate();
    if (result && !result.ok && result.blocked) {
      setBlocked(result.blocked);
      setPhase("waiting");
      setNoticeOpen(true);
    }
  };

  const installRecovery = async () => {
    setRecoveryError(null);
    const result = await window.electronAPI?.installUpdateRecovery?.();
    if (result && !result.ok && result.blocked) setRecoveryError(result.blocked.message);
  };

  const handleClick = () => {
    if (phase === "downloaded") {
      void install();
      return;
    }
    if (phase === "waiting") {
      setNoticeOpen(true);
      return;
    }
    setPhase("checking");
    setMessage(null);
    void window.electronAPI?.checkForUpdates().then((result) => {
      if (!result.ok) {
        setPhase("error");
        setMessage(result.error ?? "Update check failed.");
      }
    });
  };

  // Short visible labels — this button sits side-by-side with Logout in a
  // compact sidebar footer column, so the full-length phrases used to
  // truncate ("Check for Upd…") instead of fitting. `fullLabel` keeps the
  // descriptive phrase for the hover tooltip.
  const fullLabel =
    phase === "checking"
      ? "Checking…"
      : phase === "downloading"
        ? `Downloading ${percent}%`
        : phase === "downloaded"
          ? "Restart to update"
          : phase === "waiting"
            ? blocked?.message ?? "Update waiting"
            : phase === "not-available"
              ? "Up to date"
              : phase === "error"
                ? "Check failed"
                : "Check for Updates";
  const label =
    phase === "checking"
      ? "Checking…"
      : phase === "downloading"
        ? `${percent}%`
        : phase === "downloaded"
          ? "Restart"
          : phase === "waiting"
            ? "Waiting"
            : phase === "not-available"
              ? "Updated"
              : phase === "error"
                ? "Failed"
                : "Update";

  return (
    <div className="update-checker">
      <button
        type="button"
        className="logout-btn"
        onClick={handleClick}
        disabled={busy}
        title={message ?? fullLabel}
        data-testid="update-button"
        data-phase={phase}
      >
        <span className="material-symbols-rounded">{ICONS[phase]}</span>
        <span>{label}</span>
      </button>
      <div className="update-version" data-testid="app-version">v{version ?? APP_VERSION}</div>
      <Modal
        open={noticeOpen}
        title="Update waiting"
        description={`Version ${updateVersion ?? "?"} is downloaded but will not install yet.`}
        onClose={() => setNoticeOpen(false)}
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => { useSyncStore.getState().setStatus({ exportRequestedAt: Date.now() }); setNoticeOpen(false); }}>
              Export pending
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void drainOutbox().catch(() => undefined)}>
              Sync now
            </Button>
            <Button variant="danger" size="sm" onClick={() => void installRecovery()} data-testid="update-install-recovery">
              Install anyway (after export)
            </Button>
          </div>
        }
      >
        <p className="text-sm text-slate-700" data-testid="update-guard-message">{blocked?.message}</p>
        <p className="mt-3 text-xs text-slate-500">
          Nothing is lost by waiting: the app keeps working on this version and installs the update on the next
          restart once every sale has synced. Owner only: if sales cannot sync (server down), export them first,
          keep the file, then use "Install anyway".
        </p>
        {recoveryError && <p className="mt-3 text-xs text-rose-700" role="alert">{recoveryError}</p>}
      </Modal>
    </div>
  );
};
