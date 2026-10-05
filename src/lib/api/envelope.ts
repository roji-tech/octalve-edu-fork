import { NextResponse } from "next/server";

// PRD §7's mandatory response shape: "every response is { data, meta, error }
// — never a bare array or ad hoc shape." First API route in the repo, so
// this is where that convention starts.
export function ok<T>(
  data: T,
  meta: Record<string, unknown> = {},
  status = 200,
) {
  return NextResponse.json({ data, meta, error: null }, { status });
}

/// One field-level problem, for a 400 the client can show next to the right input.
export type ErrorDetail = { path: string; message: string };

export function fail(message: string, status: number, code?: string, details?: ErrorDetail[]) {
  return NextResponse.json(
    { data: null, meta: {}, error: { code: code ?? String(status), message, ...(details && details.length > 0 ? { details } : {}) } },
    { status },
  );
}

/// Marks a response uncacheable. Every auth response must carry this: a
/// shared cache or the browser's back/forward cache must never replay a
/// login/logout/session response. (Added here first; AlEemaan adopts it in
/// the cross-repo sync pass — see domain-implementation-plan.md §0.5.1.)
export function noStore<T extends NextResponse>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
