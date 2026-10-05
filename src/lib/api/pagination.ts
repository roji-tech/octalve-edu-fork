// Pagination helpers (domain-implementation-plan.md §0.5.3, A). Two shapes, as PRD §7 says: OFFSET (`page`/`limit`)
// for small stable lists, CURSOR (keyset on `(createdAt, id)`) for high-churn ones (attendance, audit). Both are
// strict on purpose: a malformed, repeated or out-of-range parameter is a 400 with the field named — never silently
// "first value wins" or "clamped to something else", which is how a client bug becomes a data bug.

import type { ErrorDetail } from "@/lib/api/envelope";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const MAX_PAGE = 100_000;
const MAX_CURSOR_LENGTH = 256;

type Options = { defaultLimit?: number; maxLimit?: number };
type Refused = { ok: false; issues: ErrorDetail[] };

/// A single, plain, non-negative-integer-looking parameter: absent → undefined; repeated, empty, signed, decimal,
/// exponent or padded → an issue.
function readInteger(params: URLSearchParams, name: string, issues: ErrorDetail[]): number | undefined {
  const all = params.getAll(name);
  if (all.length === 0) return undefined;
  if (all.length > 1) {
    issues.push({ path: name, message: `Give ${name} once.` });
    return undefined;
  }
  if (!/^\d{1,9}$/.test(all[0])) {
    issues.push({ path: name, message: `${name} must be a whole number.` });
    return undefined;
  }
  return Number(all[0]);
}

export type OffsetPage = { ok: true; page: number; limit: number; skip: number; take: number };

/// `?page=2&limit=50` → `{ page, limit, skip, take }` for Prisma's `skip`/`take`.
export function parseOffsetPagination(params: URLSearchParams, options: Options = {}): OffsetPage | Refused {
  const { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = options;
  const issues: ErrorDetail[] = [];
  const page = readInteger(params, "page", issues) ?? 1;
  const limit = readInteger(params, "limit", issues) ?? defaultLimit;
  if (page < 1 || page > MAX_PAGE) issues.push({ path: "page", message: `page must be between 1 and ${MAX_PAGE}.` });
  if (limit < 1 || limit > maxLimit) issues.push({ path: "limit", message: `limit must be between 1 and ${maxLimit}.` });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, page, limit, skip: (page - 1) * limit, take: limit };
}

export type OffsetMeta = { page: number; limit: number; total: number; pages: number; hasNext: boolean };

export function offsetMeta(input: { page: number; limit: number; total: number }): OffsetMeta {
  const pages = Math.max(1, Math.ceil(input.total / input.limit));
  return { page: input.page, limit: input.limit, total: input.total, pages, hasNext: input.page < pages };
}

// --- cursor (keyset) ---------------------------------------------------------------------------------------------------

export type Cursor = { createdAt: Date; id: string };

/// The cursor is `base64url(JSON { t: ISO time, id })` — opaque to clients, but NOT a secret and NOT trusted: it
/// only narrows a query that is already tenant-scoped, and it is validated as strictly as any other input.
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), id: cursor.id })).toString("base64url");
}

export function decodeCursor(raw: string): Cursor | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { t, id } = parsed as { t?: unknown; id?: unknown };
    if (typeof t !== "string" || typeof id !== "string" || id.length === 0 || id.length > 128) return null;
    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== t) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export type CursorPage = { ok: true; limit: number; take: number; after: Cursor | null };

/// `?limit=50&after=<cursor>`. `take` is `limit + 1`: fetch one extra row to learn whether a next page exists
/// without a COUNT, then hand the rows to `cursorMeta`.
export function parseCursorPagination(params: URLSearchParams, options: Options = {}): CursorPage | Refused {
  const { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = options;
  const issues: ErrorDetail[] = [];
  const limit = readInteger(params, "limit", issues) ?? defaultLimit;
  if (limit < 1 || limit > maxLimit) issues.push({ path: "limit", message: `limit must be between 1 and ${maxLimit}.` });

  let after: Cursor | null = null;
  const cursors = params.getAll("after");
  if (cursors.length > 1) issues.push({ path: "after", message: "Give after once." });
  else if (cursors.length === 1) {
    after = decodeCursor(cursors[0]);
    if (!after) issues.push({ path: "after", message: "after is not a valid cursor." });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, limit, take: limit + 1, after };
}

/// Splits the `limit + 1` rows into the page and the next cursor.
export function cursorMeta<T extends { createdAt: Date; id: string }>(rows: T[], limit: number): { items: T[]; meta: { limit: number; nextCursor: string | null } } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;
  return { items, meta: { limit, nextCursor } };
}
