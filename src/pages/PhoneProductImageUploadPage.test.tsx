import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// The phone page is translated through the shared i18n strings (English +
// Myanmar). Its first render (before the session is read) shows the
// "checking" line and a language switch; the rate-limit wording is covered in
// lib/productImagePhoneUpload.rateLimit.test.ts.
vi.mock("../lib/supabase", () => ({ supabase: {} }));
// Server rendering reads zustand's initial snapshot, so the language comes
// from this stand-in for useTranslation (same template logic, real strings).
let lang: "en" | "my" = "en";
vi.mock("../hooks/useTranslation", async () => {
  const { getTranslation } = await import("../i18n/translations");
  return {
    useTranslation: () => ({
      language: lang,
      setLanguage: () => undefined,
      isZawgyi: false,
      t: (section: string, key: string, vars?: Record<string, string | number>) => {
        let text = getTranslation(lang, section, key);
        for (const [k, v] of Object.entries(vars ?? {})) text = text.replaceAll("{" + k + "}", String(v));
        return text;
      },
    }),
  };
});

const { PhoneProductImageUploadPage } = await import("./PhoneProductImageUploadPage");

const render = () =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={["/phone-upload/product-image/" + "q".repeat(128)]}>
      <Routes>
        <Route path="/phone-upload/product-image/:token" element={<PhoneProductImageUploadPage />} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => {
  lang = "en";
});

describe("PhoneProductImageUploadPage i18n", () => {
  it("English: title, checking line, buttons, switch offers Myanmar", () => {
    lang = "en";
    const html = render();
    expect(html).toContain("Product photo upload");
    expect(html).toContain("Checking upload link...");
    expect(html).toContain("Take photo");
    expect(html).toContain("Choose from library");
    expect(html).toContain('data-testid="phone-upload-language"');
    expect(html).toContain("မြန်မာ");
  });

  it("Myanmar: the same page in Myanmar script, switch offers English", () => {
    lang = "my";
    const html = render();
    expect(html).not.toContain("Checking upload link...");
    expect(html).not.toContain("Take photo");
    expect(html).toContain("အပ်လုဒ်လင့်ခ်ကို စစ်ဆေးနေသည်...");
    expect(html).toContain("ဓာတ်ပုံရိုက်ရန်");
    expect(html).toContain(">English<");
  });
});
