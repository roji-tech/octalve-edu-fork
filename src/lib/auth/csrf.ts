import { NextRequest } from "next/server";

// Same-origin check for state-changing requests (no CSRF token infrastructure: the session cookie is SameSite=Lax
// and this is the second, independent defence). Two signals, both must pass:
//
//  1. `Sec-Fetch-Site`, when the browser sends it (all current ones do): `same-origin` and `none` (a user-typed or
//     bookmarked navigation) pass; `cross-site` and `same-site` are REFUSED. `same-site` matters here: a sibling
//     subdomain — the cookieless domain uploaded content will live on, or another tenant's custom domain — shares our
//     registrable domain, and must not be able to ride a session. An absent header (curl, an old browser, a server
//     talking to us) falls through to the second signal.
//  2. `Origin` (or `Referer` as a fallback) must be exactly this request's own host. Both absent → refused.
//
// "This request's own host" is the `Host` header — NOT `X-Forwarded-Host`, which any client can send, unless the
// operator says a reverse proxy sets it (`TRUST_FORWARDED_HOST=true`, which then also means the proxy must overwrite
// it). Without the proxy's say-so we never read it. (When there is no Host header at all, e.g. a request built
// in-process, the URL's own host is used.)

const trustForwardedHost = () => process.env.TRUST_FORWARDED_HOST === "true";

export function validateCSRF(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;

  const host = (trustForwardedHost() ? req.headers.get("x-forwarded-host") : null) || req.headers.get("host") || req.nextUrl.host;
  if (!host) return false;

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch {
      return false;
    }
  }

  return false;
}
