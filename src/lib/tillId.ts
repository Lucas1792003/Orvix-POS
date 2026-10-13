// A stable, non-secret identifier for this till (one per app profile), used
// to label queue exports. Kept in localStorage — device-local, survives
// restarts and sign-outs, never sent to the server. Created on first use.
const TILL_ID_KEY = "pos-till-id";

export function getTillId(): string {
  try {
    const existing = localStorage.getItem(TILL_ID_KEY);
    if (existing && /^till-[a-z0-9]{6,32}$/.test(existing)) return existing;
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    const id = `till-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    localStorage.setItem(TILL_ID_KEY, id);
    return id;
  } catch {
    return "till-unknown";
  }
}
