import { HTTP_URL } from "./env";
import { uniqueIp } from "./db";

// Plain `fetch` on purpose, not Playwright's APIRequestContext: that keeps a
// cookie jar between calls, which would silently attach a session to a request
// a test means to send anonymously. Here every header — Cookie, Origin,
// X-Real-IP — is exactly what the test wrote and nothing else.

export type ApiOptions = {
  method?: string;
  /// JSON-serialised unless `rawBody` is given.
  body?: unknown;
  rawBody?: string;
  /// Client IP the server sees: a fresh unique one by default (own rate-limit
  /// buckets); pass a string to reuse one; `null` sends no IP header at all.
  ip?: string | null;
  /// `undefined` = same-origin (the app's own URL); `null` = send no Origin.
  origin?: string | null;
  cookie?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
};

export type ApiResponse = {
  status: number;
  headers: Headers;
  setCookies: string[];
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
};

export async function api(path: string, opts: ApiOptions = {}): Promise<ApiResponse> {
  const baseUrl = opts.baseUrl ?? HTTP_URL;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined || opts.rawBody !== undefined) headers["content-type"] = "application/json";
  if (opts.origin !== null) headers.origin = opts.origin ?? baseUrl;
  if (opts.ip !== null) headers["x-real-ip"] = opts.ip ?? uniqueIp();
  if (opts.cookie) headers.cookie = opts.cookie;
  Object.assign(headers, opts.headers);

  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? (opts.body !== undefined || opts.rawBody !== undefined ? "POST" : "GET"),
    headers,
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    redirect: "manual",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (e.g. a redirect or an HTML page)
  }
  return { status: res.status, headers: res.headers, setCookies: res.headers.getSetCookie(), text, json };
}

export type ParsedCookie = {
  name: string;
  value: string;
  attributes: Map<string, string | true>;
  raw: string;
};

export function parseSetCookie(raw: string): ParsedCookie {
  const [pair, ...attrs] = raw.split(";").map((part) => part.trim());
  const eq = pair.indexOf("=");
  const attributes = new Map<string, string | true>();
  for (const attr of attrs) {
    const i = attr.indexOf("=");
    if (i === -1) attributes.set(attr.toLowerCase(), true);
    else attributes.set(attr.slice(0, i).toLowerCase(), attr.slice(i + 1));
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes, raw };
}

export const COOKIE_NAME = "octalve.session-token";

/// The session cookie from a response's Set-Cookie headers (undefined if none).
export function sessionCookie(res: ApiResponse, name = COOKIE_NAME): ParsedCookie | undefined {
  return res.setCookies.map(parseSetCookie).find((c) => c.name === name);
}

export const cookieHeader = (token: string, name = COOKIE_NAME) => `${name}=${token}`;

/// `remember` is sent only when given, so a bare `loginAs(user)` exercises the API's default
/// (not remembered: a session cookie and a 12-hour server-side cap).
export async function loginAs(
  user: { email: string; password: string },
  { remember, ...opts }: ApiOptions & { remember?: boolean } = {},
): Promise<ApiResponse & { token: string | null }> {
  const res = await api("/api/v1/auth/login", {
    ...opts,
    method: "POST",
    body: {
      email: user.email,
      password: user.password,
      ...(remember === undefined ? {} : { remember }),
    },
  });
  const cookie = sessionCookie(res);
  return Object.assign(res, { token: cookie && cookie.value ? cookie.value : null });
}
