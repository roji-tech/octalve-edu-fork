// A tiny client-side helper for the account page's forms: POST/PATCH JSON, same-origin, and reduce every outcome
// (including "the network is down") to one shape, so each panel only decides what to SAY about it.

export type FieldProblem = { path: string; message: string };
export type Reply = {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
  /// Pagination etc. (the envelope's `meta`).
  meta?: Record<string, unknown>;
  /// Field-level problems from a 400 (`body.email`, `body.role`, …), to show next to the right input.
  details?: FieldProblem[];
};

async function request(path: string, init: RequestInit): Promise<Reply> {
  try {
    const res = await fetch(path, { credentials: "same-origin", ...init });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, code: json?.error?.code, message: json?.error?.message, data: json?.data, meta: json?.meta, details: json?.error?.details };
  } catch {
    return { ok: false, status: 0, code: "NETWORK" };
  }
}

export function sendJson(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<Reply> {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function getJson(path: string, signal?: AbortSignal): Promise<Reply> {
  return request(path, { method: "GET", signal });
}

/// The message of the first problem for `field` (`"email"` matches `body.email`), if any.
export const problemFor = (reply: Reply, field: string): string | undefined => reply.details?.find((d) => d.path === `body.${field}`)?.message;

export const NETWORK_ERROR = "Can't reach the server. Check your internet connection and try again.";
export const GENERIC_ERROR = "That didn't work. Please try again in a moment.";
export const RATE_LIMITED = "Too many attempts. Please wait a few minutes and try again.";
export const SESSION_ENDED = "Your session has ended. Please sign in again.";
