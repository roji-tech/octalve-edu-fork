import "../support/env";
import { test, expect } from "@playwright/test";
import { API_CSP, buildCsp, generateNonce } from "@/lib/security/csp";

// The policy's shape, as pure functions (domain-implementation-plan.md §0.5.B). Whether a real browser
// enforces it, and whether every real flow survives it, is tests/api/csp.spec.ts and tests/e2e/csp.spec.ts.

const directive = (policy: string, name: string) =>
  policy.split("; ").find((d) => d === name || d.startsWith(`${name} `));

test.describe("generateNonce", () => {
  test("is 128 bits of base64", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/); // 16 bytes
    expect(Buffer.from(nonce, "base64")).toHaveLength(16);
  });

  test("never repeats (10,000 draws)", () => {
    const seen = new Set(Array.from({ length: 10_000 }, generateNonce));
    expect(seen.size).toBe(10_000);
  });
});

test.describe("buildCsp (production, plain-HTTP deployment)", () => {
  const nonce = "AAAAAAAAAAAAAAAAAAAAAA==";
  const policy = buildCsp({ nonce });

  test("scripts: self + this request's nonce + strict-dynamic — and nothing that re-opens inline script", () => {
    expect(directive(policy, "script-src")).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(directive(policy, "script-src")).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
  });

  test("styles carry the nonce too, with no blanket unsafe-inline", () => {
    expect(directive(policy, "style-src")).toBe(`style-src 'self' 'nonce-${nonce}'`);
  });

  test("everything else is closed down", () => {
    expect(directive(policy, "default-src")).toBe("default-src 'self'");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'self'");
    expect(directive(policy, "form-action")).toBe("form-action 'self'");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
  });

  test("upgrade-insecure-requests is NOT sent on a plain-HTTP deployment (it would break every sub-request)", () => {
    expect(policy).not.toContain("upgrade-insecure-requests");
  });
});

test.describe("buildCsp variants", () => {
  test("https deployments add upgrade-insecure-requests", () => {
    expect(buildCsp({ nonce: "n", https: true })).toContain("upgrade-insecure-requests");
  });

  test("only development relaxes script-src (eval for React's tooling) and connect-src (HMR websocket)", () => {
    const dev = buildCsp({ nonce: "n", dev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws:");
    expect(directive(dev, "script-src")).not.toContain("unsafe-inline");
    expect(buildCsp({ nonce: "n" })).not.toContain("unsafe-eval");
  });

  test("the API policy loads nothing and can't be framed", () => {
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
