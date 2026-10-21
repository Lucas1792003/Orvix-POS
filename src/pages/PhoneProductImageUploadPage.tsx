import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useParams } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { compressProductImage, formatImageSize } from "../lib/compressProductImage";
import {
  adviseOnRateLimit,
  getProductImageUploadSessionByToken,
  PHONE_UPLOAD_MAX_RATE_LIMIT_RETRIES,
  PhoneUploadInactiveError,
  PhoneUploadRateLimitedError,
  PhoneUploadRefusedError,
  uploadPhoneProductImage,
  type ProductImageUploadSessionStatusResult,
} from "../lib/productImagePhoneUpload";
import { reportError } from "../lib/errors";
import { useTranslation } from "../hooks/useTranslation";
import { phoneUploadRateLimitMessage, phoneUploadStatusText, type UploadPhase } from "../lib/phoneUploadMessages";


export const PhoneProductImageUploadPage = () => {
  const { token = "" } = useParams<{ token: string }>();
  const { t, language, setLanguage } = useTranslation();
  const [waitSeconds, setWaitSeconds] = useState(0);
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
      setError(t("phoneUpload", "invalidLink"));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t only changes the wording, not the session
  }, [token]);

  // 081: countdown while the phone waits out a short 429 by itself; the
  // upload continues inside uploadPhoneProductImage when the wait is over.
  useEffect(() => {
    if (phase !== "waiting") return;
    if (waitSeconds <= 0) {
      setPhase("uploading");
      return;
    }
    const timer = window.setTimeout(() => setWaitSeconds((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [phase, waitSeconds]);

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
      // A 429 (rate limited) with a short Retry-After is waited out and
      // retried automatically (bounded); a long one ends here with a message.
      const completed = await uploadPhoneProductImage(token, image, {
        sessionExpiresAt: session.expiresAt,
        onRateLimitWait: (seconds) => {
          setWaitSeconds(seconds);
          setPhase("waiting");
        },
      });
      setSession(completed);
      setPhase("complete");
    } catch (e) {
      if (e instanceof PhoneUploadInactiveError) {
        setPhase(e.status === "COMPLETED" ? "complete" : e.status === "CANCELED" ? "cancelled" : "expired");
        return;
      }
      if (e instanceof PhoneUploadRateLimitedError) {
        const advice = adviseOnRateLimit(e.retryAfterSeconds, {
          expiresAt: session.expiresAt,
          retriesSoFar: PHONE_UPLOAD_MAX_RATE_LIMIT_RETRIES,
        });
        // the link cannot be used again before it expires -> final; otherwise
        // the user may pick the photo again later
        setPhase(advice.kind === "linkExhausted" ? "error" : "ready");
        setError(phoneUploadRateLimitMessage(t, advice));
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

  const busy = phase === "loading" || phase === "compressing" || phase === "uploading" || phase === "waiting";
  const canChoose = phase === "ready";
  const statusText = phoneUploadStatusText(t, phase, waitSeconds);

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-900">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-md flex-col justify-center">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xl">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
              <span className="material-symbols-rounded">photo_camera</span>
            </div>
            <div className="flex-1">
              <h1 className="text-lg font-bold">{t("phoneUpload", "title")}</h1>
              <p className="text-sm text-slate-500">Orvix POS</p>
            </div>
            <button
              type="button"
              onClick={() => setLanguage(language === "en" ? "my" : "en")}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600"
              data-testid="phone-upload-language"
            >
              {t("phoneUpload", "language")}
            </button>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700">
            {statusText}
          </div>

          {compressedBytes !== null && (
            <p className="mt-3 text-sm font-medium text-emerald-700">
              {t("phoneUpload", "compressed", { size: formatImageSize(compressedBytes) })}
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
              {t("phoneUpload", "takePhoto")}
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
              {t("phoneUpload", "chooseFromLibrary")}
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
              {t("phoneUpload", "complete")}
            </p>
          )}
        </div>
      </div>
    </main>
  );
};
