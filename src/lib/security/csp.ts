// The Content-Security-Policy, as pure functions so it can be tested without a server.
// Design: domain-implementation-plan.md §0.5.B. Wired up by src/proxy.ts.

/// A fresh 128-bit nonce, base64. One per request — the whole protection is that an attacker who
/// can inject markup cannot know it.
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export type CspOptions = {
  nonce: string;
  /// `next dev` only: React's dev tooling needs eval, and HMR needs a websocket.
  dev?: boolean;
  /// APP_URL is https. `upgrade-insecure-requests` on a plain-HTTP (LAN) install would make the
  /// browser rewrite every sub-request to https and break the whole app, so it is https-only.
  https?: boolean;
};

export function buildCsp({ nonce, dev = false, https = false }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    // 'strict-dynamic': the nonced bootstrap may load Next's chunks without a host allow-list.
    // No 'unsafe-inline' and — outside dev — no 'unsafe-eval'.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/// What every JSON API response carries (static — no nonce needed, nothing to run): a response with
/// no resources to load and no framing.
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
