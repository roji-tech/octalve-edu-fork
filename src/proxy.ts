import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, generateNonce } from "@/lib/security/csp";

// Per-request nonce-based CSP (domain-implementation-plan.md §0.5.B). Next 16 calls this file `proxy`
// (it was `middleware`). The nonce goes on the REQUEST headers — Next reads the policy from there and
// stamps the nonce on its own framework scripts while server-rendering — and on the RESPONSE, which
// is what the browser enforces. That is why every page must render dynamically (they all do).
//
// CSP_REPORT_ONLY=true sends the same policy as Content-Security-Policy-Report-Only: violations show
// in the browser console but nothing is blocked. It is a valve for diagnosing an unforeseen violation
// on a live deployment without an outage; the default is enforcing.
export function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const policy = buildCsp({
    nonce,
    dev: process.env.NODE_ENV === "development",
    https: (process.env.APP_URL ?? "").startsWith("https://"),
  });
  const header =
    process.env.CSP_REPORT_ONLY === "true"
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy";

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(header, policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(header, policy);
  return response;
}

export const config = {
  matcher: [
    // Pages only. The API has its own static policy (next.config.ts); static assets need none.
    // Prefetches are skipped, as Next's guide recommends.
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
