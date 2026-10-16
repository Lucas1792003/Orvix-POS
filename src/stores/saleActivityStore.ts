import { create } from "zustand";

// "Is a sale being rung up right now?" — set by the POS page (cart not
// empty, payment dialog open, or a checkout in flight). The desktop updater
// guard (lib/updateGuardBridge.ts → electron/updateGuard.cjs) never
// installs an update while this is true, not even on the owner's explicit
// recovery path, so an NSIS update can never interrupt a checkout.
interface SaleActivityState {
  saleInProgress: boolean;
  setSaleInProgress: (value: boolean) => void;
}

export const useSaleActivityStore = create<SaleActivityState>()((set) => ({
  saleInProgress: false,
  setSaleInProgress: (value) => set({ saleInProgress: value }),
}));
