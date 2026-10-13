import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SetupView, type SetupViewProps } from "./SetupPage";
import { validateSetupForm } from "../lib/setupValidation";

// The /setup page renders its form — the only thing that can lead to an
// account being created — strictly when the server has said setup is
// needed. Every other status (still checking, already done, could not
// confirm) is a read-only message. The container's status comes from
// isAppSetupNeeded(), covered in stores/authStore.setup.test.ts.

const baseProps = (over: Partial<SetupViewProps> = {}): SetupViewProps => ({
  status: "needed",
  statusDetail: null,
  backendHost: "lucashome.tail8a86e4.ts.net",
  email: "",
  confirmEmail: "",
  password: "",
  acknowledged: false,
  error: "",
  isSubmitting: false,
  onEmailChange: vi.fn(),
  onConfirmEmailChange: vi.fn(),
  onPasswordChange: vi.fn(),
  onAcknowledgedChange: vi.fn(),
  onSubmit: vi.fn(),
  ...over,
});

const render = (props: SetupViewProps) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SetupView {...props} />
    </MemoryRouter>,
  );

describe("SetupView", () => {
  it("renders the form (email, confirm email, password, acknowledgement) only when setup is needed", () => {
    const html = render(baseProps({ status: "needed" }));
    expect(html).toContain('data-testid="setup-form"');
    expect(html).toContain('id="setup-email"');
    expect(html).toContain('id="setup-email-confirm"');
    expect(html).toContain('id="setup-password"');
    expect(html).toContain('data-testid="setup-ack"');
    expect(html).toContain("Create administrator");
  });

  it.each(["checking", "done", "unavailable"] as const)("renders no form while status is %s", (status) => {
    const html = render(baseProps({ status, statusDetail: "Could not find the function public.app_setup_needed" }));
    expect(html).not.toContain('data-testid="setup-form"');
    expect(html).not.toContain('id="setup-email"');
    expect(html).not.toContain("Create administrator");
    expect(html).toContain('data-testid="setup-status"');
  });

  it("explains an unconfirmed status instead of offering setup", () => {
    const html = render(baseProps({ status: "unavailable", statusDetail: "Failed to fetch" }));
    expect(html).toContain("Could not confirm with the backend");
    expect(html).toContain("Failed to fetch");
  });

  it("always shows which backend the page would act on", () => {
    for (const status of ["checking", "needed", "done", "unavailable"] as const) {
      expect(render(baseProps({ status }))).toContain("lucashome.tail8a86e4.ts.net");
    }
  });
});

describe("validateSetupForm()", () => {
  const ok = { email: "owner@shop.test", confirmEmail: "Owner@Shop.test", password: "pw123456", acknowledged: true };

  it("accepts a complete, confirmed form (email match is case-insensitive)", () => {
    expect(validateSetupForm(ok)).toBeNull();
  });

  it("requires the email to be typed twice identically", () => {
    expect(validateSetupForm({ ...ok, confirmEmail: "owner@shop.tset" })).toMatch(/do not match/);
  });

  it("requires the explicit acknowledgement", () => {
    expect(validateSetupForm({ ...ok, acknowledged: false })).toMatch(/Confirm that you understand/);
  });

  it("requires email, password and a minimum password length", () => {
    expect(validateSetupForm({ ...ok, email: "" })).toMatch(/required/);
    expect(validateSetupForm({ ...ok, password: "" })).toMatch(/required/);
    // 8 = the staff-admin function's PASSWORD_MIN (above GoTrue's default 6)
    expect(validateSetupForm({ ...ok, password: "abc1234" })).toMatch(/at least 8/);
    expect(validateSetupForm({ ...ok, password: "x".repeat(73) })).toMatch(/at most 72/);
  });
});
