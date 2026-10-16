// Local-only harness for the desktop QR modal (D300 investigation,
// docs/selfhost-migration/phase-f/app-bugfixes.md). Renders the REAL
// ProductImageInput + ProductImagePhoneUploadModal under React StrictMode,
// with a parent that re-renders on a timer (new callback identities, new
// props objects - what store updates / realtime events / auth refreshes do
// to the product form) and can be unmounted / re-keyed on demand. run.mjs
// drives it in Chromium with a fake clock and a fully mocked backend.
/* eslint-disable react-refresh/only-export-components -- entry module, nothing to export */
import { StrictMode, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "../../src/index.css";
import { ProductImageInput } from "../../src/components/forms/ProductImageInput";

interface HarnessControls {
  setMounted: (mounted: boolean) => void;
  rekey: () => void;
  setRerenderMs: (ms: number) => void;
}

declare global {
  interface Window {
    __harness?: HarnessControls;
  }
}

const Host = () => {
  const [mounted, setMounted] = useState(true);
  const [key, setKey] = useState(0);
  const [tick, setTick] = useState(0);
  const [rerenderMs, setRerenderMs] = useState(1_000);
  const [value, setValue] = useState<string | undefined>();

  useEffect(() => {
    if (rerenderMs <= 0) return;
    const t = window.setInterval(() => setTick((n) => n + 1), rerenderMs);
    return () => window.clearInterval(t);
  }, [rerenderMs]);

  useEffect(() => {
    window.__harness = {
      setMounted,
      rekey: () => setKey((k) => k + 1),
      setRerenderMs,
    };
  }, []);

  if (!mounted) return <div data-testid="unmounted">unmounted (tick {tick})</div>;
  return (
    <div data-testid="host" data-tick={tick} style={{ padding: 24 }}>
      <ProductImageInput
        key={key}
        productId="prod-1"
        // a fresh string each render, like a store selector returning a copied value
        shopId={["shop", "1"].join("-")}
        value={value}
        // a new function identity on every render, like the product form's inline onChange
        onChange={(v) => setValue(v)}
      />
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Host />
  </StrictMode>,
);
