// A tiny client-side helper for the account page's forms: POST/PATCH JSON, same-origin, and reduce every outcome
// (including "the network is down") to one shape, so each panel only decides what to SAY about it.

export type Reply = { ok: boolean; status: number; code?: string; message?: string; data?: Record<string, unknown> };

export async function sendJson(path: string, method: "POST" | "PATCH", body?: unknown): Promise<Reply> {
  try {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, code: json?.error?.code, message: json?.error?.message, data: json?.data };
  } catch {
    return { ok: false, status: 0, code: "NETWORK" };
  }
}

export const NETWORK_ERROR = "Can't reach the server. Check your internet connection and try again.";
export const GENERIC_ERROR = "That didn't work. Please try again in a moment.";
export const RATE_LIMITED = "Too many attempts. Please wait a few minutes and try again.";
export const SESSION_ENDED = "Your session has ended. Please sign in again.";
