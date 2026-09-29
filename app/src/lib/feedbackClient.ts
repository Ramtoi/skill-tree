import { sanitizeFeedbackContext } from "./feedbackContext";
/** No provider text reaches the UI. Unknown outcomes retain the draft. */
export const FEEDBACK_ENDPOINT = "https://formspree.io/f/xljdeorj";
export type FeedbackPayload = { message: string; screen: string; tab: string; appVersion: string; os: string };
export type FeedbackResult =
  | { kind: "accepted" }
  | { kind: "validation" | "blocked" | "unavailable" | "uncertain"; retryAt?: never }
  | { kind: "limited"; retryAt?: number };
export type FeedbackTransport = (payload: FeedbackPayload) => Promise<FeedbackResult>;

export function messageError(message: string): string | null {
  if (!message.trim()) return "Enter a message before you send.";
  if (Array.from(message).length > 4000) return "Keep your message to 4,000 characters or fewer.";
  return null;
}

export function createFeedbackTransport(fetcher: typeof fetch): FeedbackTransport {
  return async (payload) => {
    // Rebuild the object so extra properties cannot leave the app.
    const body = JSON.stringify({ message: payload.message, ...sanitizeFeedbackContext(payload) });
    if (messageError(payload.message) || new TextEncoder().encode(body).length > 32768) {
      return { kind: "validation" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(FEEDBACK_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
        body, signal: controller.signal,
      });
      if (response.redirected) return { kind: "uncertain" };
      if (response.status === 403) return { kind: "blocked" };
      if (response.status === 429) {
        const value = response.headers.get("Retry-After");
        const delay = value && /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value ?? "");
        return { kind: "limited", ...(Number.isFinite(delay) && delay > Date.now() ? { retryAt: delay } : {}) };
      }
      if (response.status === 400 || response.status === 422) return { kind: "validation" };
      if (!response.ok) return { kind: "unavailable" };
      const contentType = response.headers.get("Content-Type")?.toLowerCase();
      if (contentType?.includes("text/html")) return { kind: "blocked" };
      if (!contentType?.includes("application/json")) return { kind: "uncertain" };
      const data: unknown = await response.json();
      // Native Linux probe, 2026-09-17: HTTP 200, {"next":"/thanks","ok":true}.
      return data && typeof data === "object" && "ok" in data && data.ok === true && "next" in data && data.next === "/thanks"
        ? { kind: "accepted" } : { kind: "uncertain" };
    } catch {
      return { kind: "uncertain" };
    } finally {
      clearTimeout(timeout);
    }
  };
}
