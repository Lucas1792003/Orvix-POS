import { useCallback, useRef, useState, type ChangeEvent } from "react";
import { compressProductImage, formatImageSize } from "../../lib/compressProductImage";
import { uploadProductImage } from "../../lib/productImageStorage";
import { ProductImagePhoneUploadModal } from "./ProductImagePhoneUploadModal";

interface ProductImageInputProps {
  /** Product id — used to build the Supabase Storage path for the image. */
  productId: string;
  /** Current shop context, stored on temporary phone upload sessions when available. */
  shopId?: string | null;
  /** Current image — a Supabase Storage public URL (or a legacy value). */
  value: string | undefined;
  /** Called with the new Storage public URL, or `undefined` when removed. */
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
}

type Phase = "compressing" | "uploading" | null;

/**
 * Product image picker. A selected image is resized + compressed to under
 * 100 KB (`compressProductImage`), uploaded through the server-validated
 * session flow (`uploadProductImage`: the server checks the bytes and derives
 * the URL), and only that server-derived public URL is handed back via
 * `onChange`. No base64 data URL is ever stored on the product row.
 */
export const ProductImageInput = ({ productId, shopId, value, onChange, disabled }: ProductImageInputProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [error, setError] = useState<string | null>(null);
  const [compressedBytes, setCompressedBytes] = useState<number | null>(null);
  const [phoneUploadOpen, setPhoneUploadOpen] = useState(false);

  const busy = phase !== null;

  const handleFile = async (file: File) => {
    setError(null);
    setPhase("compressing");
    try {
      const image = await compressProductImage(file);
      setCompressedBytes(image.bytes);
      setPhase("uploading");
      // G5: the server validates the stored bytes and derives the URL; the
      // organization and the object path are decided server-side.
      const url = await uploadProductImage(productId, image, { shopId });
      // Only the server-derived Storage URL reaches the product row.
      onChange(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The image could not be processed.");
    } finally {
      setPhase(null);
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the user re-pick the same file after an error
    if (file) void handleFile(file);
  };

  const handleRemove = () => {
    // Clears the row's image_url. The Storage object is left in place — see the
    // orphan-cleanup note in docs/31-product-images-storage-setup.md.
    onChange(undefined);
    setCompressedBytes(null);
    setError(null);
  };

  const handlePhoneUploaded = useCallback(
    (publicUrl: string, bytes?: number) => {
      onChange(publicUrl);
      setCompressedBytes(bytes ?? null);
      setError(null);
    },
    [onChange],
  );

  const buttonLabel =
    phase === "compressing"
      ? "Compressing…"
      : phase === "uploading"
        ? "Uploading…"
        : value
          ? "Change image"
          : "Choose image";

  return (
    <div className="flex items-start gap-4">
      {/* Fixed square thumbnail of the stored image (or a placeholder). */}
      <div className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-xl border-2 border-dashed border-slate-300 bg-slate-50">
        {value ? (
          <>
            <img
              src={value}
              alt="Product preview"
              loading="lazy"
              className="h-full w-full object-cover"
            />
            {!disabled && (
              <button
                type="button"
                onClick={handleRemove}
                aria-label="Remove image"
                className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white shadow-md hover:bg-red-600"
              >
                <span className="material-symbols-rounded text-sm">close</span>
              </button>
            )}
          </>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center text-slate-400">
            <span className="material-symbols-rounded text-2xl">image</span>
            <span className="text-xs">No image</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex-1">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-rounded text-lg">upload</span>
            {buttonLabel}
          </button>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => setPhoneUploadOpen(true)}
            className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-rounded text-lg">photo_camera</span>
            Use phone camera
          </button>
          {value && !disabled && (
            <button
              type="button"
              disabled={busy}
              onClick={handleRemove}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleChange}
        />

        <p className="mt-1 text-xs text-slate-500">
          Images are compressed below 100 KB and stored in Supabase Storage for fast POS
          loading. JPEG, PNG or WebP, max 10 MB.
        </p>
        {compressedBytes !== null && !error && !busy && (
          <p className="mt-1 text-xs font-medium text-emerald-600">
            Compressed: {formatImageSize(compressedBytes)} · uploaded
          </p>
        )}
        {busy && (
          <p className="mt-1 text-xs text-slate-500">
            {phase === "compressing" ? "Compressing image…" : "Uploading to storage…"}
          </p>
        )}
        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      </div>
      <ProductImagePhoneUploadModal
        open={phoneUploadOpen}
        productId={productId}
        shopId={shopId}
        onClose={() => setPhoneUploadOpen(false)}
        onUploaded={handlePhoneUploaded}
      />
    </div>
  );
};
