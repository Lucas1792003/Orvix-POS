import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { formatImageSize } from "../../lib/compressProductImage";
import {
  cancelProductImageUploadSession,
  createPhoneProductImageUploadSession,
  getProductImageUploadSessionStatus,
  type ProductImageUploadQrSession,
  type ProductImageUploadSessionStatus,
} from "../../lib/productImagePhoneUpload";
import { startUploadStatusPolling, type ReconnectingInfo } from "../../lib/uploadStatusPoller";

interface ProductImagePhoneUploadModalProps {
  open: boolean;
  productId: string;
  shopId?: string | null;
  onClose: () => void;
  onUploaded: (publicUrl: string, bytes?: number) => void;
}

type ModalPhase = "creating" | ProductImageUploadSessionStatus | "FAILED";

const statusLabel: Record<ModalPhase, string> = {
  creating: "Creating upload link...",
  PENDING: "Waiting for upload...",
  COMPLETED: "Upload received",
  EXPIRED: "Upload failed / expired",
  CANCELED: "Upload canceled",
  FAILED: "Upload failed / expired",
};

const getSecondsLeft = (expiresAt?: string) => {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
};

export const ProductImagePhoneUploadModal = ({
  open,
  productId,
  shopId,
  onClose,
  onUploaded,
}: ProductImagePhoneUploadModalProps) => {
  const [session, setSession] = useState<ProductImageUploadQrSession | null>(null);
  const [phase, setPhase] = useState<ModalPhase>("creating");
  const [error, setError] = useState<string | null>(null);
  const [uploadedBytes, setUploadedBytes] = useState<number | undefined>();
  const [uploadedUrl, setUploadedUrl] = useState<string | undefined>();
  const [secondsLeft, setSecondsLeft] = useState(0);
  // Bumped by the Reupload button to start a fresh upload session (new QR).
  const [reloadNonce, setReloadNonce] = useState(0);
  // Set while status checks are failing and being retried.
  const [reconnecting, setReconnecting] = useState<ReconnectingInfo | null>(null);

  const statusTone = useMemo(() => {
    if (phase === "COMPLETED") return "text-emerald-700";
    if (phase === "FAILED" || phase === "EXPIRED" || phase === "CANCELED") return "text-rose-600";
    return "text-slate-600";
  }, [phase]);

  useEffect(() => {
    if (!open) return;

    let active = true;
    setSession(null);
    setPhase("creating");
    setError(null);
    setUploadedBytes(undefined);
    setUploadedUrl(undefined);
    setSecondsLeft(0);

    createPhoneProductImageUploadSession({ productId, shopId })
      .then((nextSession) => {
        if (!active) return;
        setSession(nextSession);
        setPhase("PENDING");
        setSecondsLeft(getSecondsLeft(nextSession.expiresAt));
      })
      .catch((e) => {
        if (!active) return;
        setPhase("FAILED");
        setError(e instanceof Error ? e.message : "Could not create the phone upload link.");
      });

    return () => {
      active = false;
    };
  }, [open, productId, shopId, reloadNonce]);

  useEffect(() => {
    if (!open || !session || phase !== "PENDING") return;
    const timer = window.setInterval(() => {
      setSecondsLeft(getSecondsLeft(session.expiresAt));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, phase, session]);

  // No token refresh here: the phone obtains its signed upload token just in
  // time from the phone-upload-token Edge Function. The desktop only polls —
  // resiliently (lib/uploadStatusPoller.ts): a failed status request shows
  // "reconnecting" and is retried with backoff until the session expires; it
  // no longer ends the modal. Keyed on the session only, so a parent that
  // re-renders with a new onUploaded does not restart polling.
  const onUploadedRef = useRef(onUploaded);
  useEffect(() => {
    onUploadedRef.current = onUploaded;
  }, [onUploaded]);
  useEffect(() => {
    if (!open || !session) return;
    const stop = startUploadStatusPolling({
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      fetchStatus: (id) => getProductImageUploadSessionStatus(id),
      onPending: (result) => setSecondsLeft(getSecondsLeft(result.expiresAt)),
      onReconnecting: setReconnecting,
      onStop: (outcome) => {
        setReconnecting(null);
        if (outcome.kind !== "status") {
          setPhase(outcome.kind === "expired" ? "EXPIRED" : "FAILED");
          setError(outcome.message);
          return;
        }
        const result = outcome.result;
        setPhase(result.status);
        setSecondsLeft(getSecondsLeft(result.expiresAt));
        if (result.status === "COMPLETED" && result.publicUrl) {
          setUploadedBytes(result.bytes);
          setUploadedUrl(result.publicUrl);
          onUploadedRef.current(result.publicUrl, result.bytes);
        }
      },
    });
    return () => {
      stop();
      setReconnecting(null);
    };
  }, [open, session]);

  const handleClose = () => {
    if (session && phase === "PENDING") {
      void cancelProductImageUploadSession(session.sessionId).catch(() => undefined);
    }
    onClose();
  };

  // Start over with a fresh QR / upload session (after a completed upload
  // the user wants a different photo, or after a failed / expired one).
  const handleReupload = () => setReloadNonce((n) => n + 1);

  // Terminal states where starting a new upload makes sense.
  const canReupload =
    phase === "COMPLETED" || phase === "FAILED" || phase === "EXPIRED" || phase === "CANCELED";

  const countdown =
    phase === "PENDING" && secondsLeft > 0
      ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
      : null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Upload from phone"
      description="Scan with your phone to take or choose a product photo."
      footer={
        <>
          {canReupload && (
            <Button
              type="button"
              variant={phase === "COMPLETED" ? "secondary" : "primary"}
              onClick={handleReupload}
            >
              {phase === "COMPLETED" ? "Reupload" : "Try again"}
            </Button>
          )}
          <Button type="button" onClick={handleClose} variant={phase === "COMPLETED" ? "primary" : "secondary"}>
            {phase === "COMPLETED" ? "Use this image" : "Close"}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-[260px_1fr] sm:items-center">
        <div className="rounded-3xl border border-emerald-100 bg-gradient-to-br from-emerald-50 via-white to-slate-50 p-4 shadow-sm">
          <div className="flex min-h-[228px] items-center justify-center rounded-2xl border border-white bg-white p-3 shadow-inner">
          {phase === "COMPLETED" && uploadedUrl ? (
            <img
              src={uploadedUrl}
              alt="Uploaded product preview"
              className="h-52 w-52 rounded-xl object-contain"
            />
          ) : session?.qrUrl && phase !== "FAILED" ? (
            <QRCodeSVG
              value={session.qrUrl}
              size={212}
              marginSize={2}
              level="Q"
              bgColor="#ffffff"
              fgColor="#0f172a"
              title="Product image phone upload QR code"
            />
          ) : (
            <div className="flex h-52 w-52 items-center justify-center rounded-xl bg-slate-50 text-sm text-slate-500">
              Preparing QR...
            </div>
          )}
          </div>
          <div className="mt-3 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-700">
            {phase === "COMPLETED" && uploadedUrl ? (
              <>
                <span className="material-symbols-rounded text-base">check_circle</span>
                Photo received
              </>
            ) : (
              <>
                <span className="material-symbols-rounded text-base">qr_code_scanner</span>
                Scan to upload
              </>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Status</div>
            <div className={`mt-1 text-base font-semibold ${statusTone}`}>{statusLabel[phase]}</div>
          </div>

          {countdown && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
              Link expires in {countdown}.
            </div>
          )}

          {phase === "PENDING" && reconnecting && (
            <div role="status" className="flex items-center gap-2 text-xs text-slate-500">
              <span className="material-symbols-rounded animate-spin text-sm">progress_activity</span>
              Connection problem, reconnecting... The phone upload is not affected.
            </div>
          )}

          {phase === "PENDING" && (
            <p className="text-sm text-slate-500">
              Scan the QR code, then use your phone camera or photo library. Keep this window open
              until the upload is received.
            </p>
          )}

          {phase === "COMPLETED" && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
              The product image preview has been updated
              {uploadedBytes ? ` (${formatImageSize(uploadedBytes)})` : ""}.
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}

          <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
            The QR code is temporary and works only for this image upload.
          </p>
        </div>
      </div>
    </Modal>
  );
};
