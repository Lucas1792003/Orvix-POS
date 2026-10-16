// Ambient type for the API the Electron preload script exposes (see
// electron/preload.cjs). Undefined in the browser build — every call site
// must feature-detect with `window.electronAPI?.` before using it.
export interface ElectronPrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
}

export interface ElectronPrintResult {
  ok: boolean;
  error?: string;
}

export interface ElectronUpdateCheckResult {
  ok: boolean;
  error?: string;
}

/** electron/updateGuard.cjs evaluateInstallGuard() result. */
export interface ElectronUpdateGuardDecision {
  allowed: boolean;
  code: "no-state" | "sale-in-progress" | "unsynced" | "offline" | "signed-out" | "ok" | "recovery" | "recovery-needs-export";
  unsynced: number;
  message: string;
}

export interface ElectronUpdateStatus {
  state: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "installing" | "error";
  version?: string;
  percent?: number;
  message?: string;
  /** "downloaded" but the install guard refuses to install yet. */
  blocked?: ElectronUpdateGuardDecision;
  /** "downloaded" and the guard allows installing now. */
  installable?: boolean;
}

export interface ElectronInstallResult {
  ok: boolean;
  blocked?: ElectronUpdateGuardDecision;
  canceled?: boolean;
  error?: string;
}

/** What the renderer reports to the install guard (counts and flags only). */
export interface ElectronAppState {
  unsynced: number;
  pending: number;
  conflict: number;
  quarantined: number;
  online: boolean;
  authenticated: boolean;
  saleInProgress: boolean;
  exportCoversQueue: boolean;
}

export interface ElectronQueueExportSaveResult {
  ok: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

export interface ElectronAPI {
  isElectron: true;
  platform: string;
  listPrinters: () => Promise<ElectronPrinterInfo[]>;
  printReceipt: (options?: { deviceName?: string }) => Promise<ElectronPrintResult>;
  appVersion: () => Promise<string>;
  checkForUpdates: () => Promise<ElectronUpdateCheckResult>;
  installUpdate: () => Promise<ElectronInstallResult>;
  onUpdateStatus: (callback: (status: ElectronUpdateStatus) => void) => () => void;
  /** 1.0.16+ (absent in older preload scripts — feature-detect). */
  installUpdateRecovery?: () => Promise<ElectronInstallResult>;
  reportAppState?: (state: ElectronAppState) => void;
  onUpdateRequest?: (callback: (request: { action: "open-export" | "sync-now" }) => void) => () => void;
  /** Save an ENCRYPTED pending-queue export through the native save dialog
   *  (main process writes; the renderer has no file-system access). */
  saveQueueExport?: (request: { defaultFileName: string; contents: string }) => Promise<ElectronQueueExportSaveResult>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
