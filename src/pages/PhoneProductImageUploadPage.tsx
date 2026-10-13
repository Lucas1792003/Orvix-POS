import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useParams } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { compressProductImage, formatImageSize } from "../lib/compressProductImage";
import {
  getProductImageUploadSessionByToken,
  PhoneUploadInactiveError,
  PhoneUploadRefusedError,
  uploadPhoneProductImage,
  type ProductImageUploadSessionStatusResult,
} from "../lib/productImagePhoneUpload";
import { reportError } from "../lib/errors";

type UploadPhase =
  | "loading"
  | "ready"
  | "compressing"
  | "uploading"
  | "complete"
  | "expired"
  | "cancelled"
  | "error";

export const PhoneProductImageUploadPage = () => {
  const { token = "" } = useParams<{ token: string }>();
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<ProductImageUploadSessionStatusResult | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [compressedBytes, setCompressedBytes] = useState<number | null>(null);
  // One upload at a time: a double tap (or a second file picked while the
  // first is still compressing) must not start a second transfer.
  const inFlightRef = useRef(false);

  useEffect(() => {
    let active = true;
    setPhase("loading");
    setError(null);

    if (!token) {
      setPhase("error");
      setError("Invalid upload link.");
      return;
    }

    getProductImageUploadSessionByToken(token)
      .then((result) => {
        if (!active) return;
        setSession(result);
        if (result.status === "PENDING") setPhase("ready");
        else if (result.status === "COMPLETED") setPhase("complete");
        else if (result.status === "EXPIRED") setPhase("expired");
        else setPhase("cancelled");
      })
      .catch((e) => {
        if (!active) return;
        setPhase("error");
        setError(reportError("PhoneProductImageUploadPage.loadSession", e, "Invalid or expired upload link."));
      });

    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (!session || phase !== "ready") return;
    const delay = Date.parse(session.expiresAt) - Date.now();
    if (delay <= 0) {
      setPhase("expired");
      return;
    }
    const timer = window.setTimeout(() => setPhase("expired"), delay);
    return () => window.clearTimeout(timer);
  }, [phase, session]);

  const handleFile = async (file: File) => {
    if (!session || phase !== "ready" || inFlightRef.current) return;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      setPhase("expired");
      return;
    }
    inFlightRef.current = true;

    setError(null);
    setPhase("compressing");
    try {
      const image = await compressProductImage(file);
      setCompressedBytes(image.bytes);

      setPhase("uploading");
      // Just in time: the signed upload token (valid ~60 s) is requested from
      // the server right now, inside uploadPhoneProductImage, immediately
      // before the transfer - never at page load. An expired token is
      // replaced once, and a transfer that already landed goes straight to
      // completion (no second object, no second completion).
      const completed = await uploadPhoneProductImage(token, image);
      setSession(completed);
      setPhase("complete");
    } catch (e) {
      if (e instanceof PhoneUploadInactiveError) {
        setPhase(e.status === "COMPLETED" ? "complete" : e.status === "CANCELED" ? "cancelled" : "expired");
        return;
      }
      setPhase("error");
      setError(
        e instanceof PhoneUploadRefusedError
          ? e.message
          : reportError("PhoneProductImageUploadPage.upload", e, "The photo could not be uploaded."),
      );
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void handleFile(file);
  };

  const busy = phase === "loading" || phase === "compressing" || phase === "uploading";
  const canChoose = phase === "ready";
  const statusText =
    phase === "loading"
      ? "Checking upload link..."
      : phase === "compressing"
        ? "Compressing photo..."
        : phase === "uploading"
          ? "Uploading photo..."
          : phase === "complete"
            ? "Photo uploaded. You can return to the computer."
            : phase === "expired"
              ? "This upload link has expired. Create a new QR code on the computer."
              : phase === "cancelled"
                ? "This upload link was cancelled on the computer. Create a new QR code to upload."
                : phase === "ready"
                  ? "Choose or take a product photo."
                  : "Upload failed.";

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-900">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-md flex-col justify-center">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xl">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
              <span className="material-symbols-rounded">photo_camera</span>
            </div>
            <div>
              <h1 className="text-lg font-bold">Product photo upload</h1>
              <p className="text-sm text-slate-500">ShwePhaLa Retail</p>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
            {statusText}
          </div>

          {compressedBytes !== null && (
            <p className="mt-3 text-sm font-medium text-emerald-700">
              Compressed: {formatImageSize(compressedBytes)}
            </p>
          )}

          {error && (
            <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          <div className="mt-5 grid gap-3">
            <Button
              type="button"
              size="lg"
              disabled={!canChoose || busy}
              onClick={() => cameraInputRef.current?.click()}
              className="w-full"
            >
              <span className="material-symbols-rounded mr-2">photo_camera</span>
              Take photo
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={!canChoose || busy}
              onClick={() => libraryInputRef.current?.click()}
              className="w-full"
            >
              <span className="material-symbols-rounded mr-2">photo_library</span>
              Choose from library
            </Button>
          </div>

          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleChange}
          />
          <input
            ref={libraryInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleChange}
          />

          {phase === "complete" && (
            <p className="mt-5 rounded-2xl bg-emerald-50 px-4 py-3 text-center text-sm font-medium text-emerald-700">
              Photo uploaded. You can return to the computer.
            </p>
          )}
        </div>
      </div>
    </main>
  );
};
