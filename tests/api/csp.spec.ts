import { HTTPS_APP_PORT } from "../support/env";
import { test, expect } from "@playwright/test";
import { seedInstance } from "../support/db";
import { api } from "../support/http";

// The nonce-based CSP over real HTTP against the production build (domain-implementation-plan.md §0.5.B).
// What a browser then does with it is tests/e2e/csp.spec.ts.

test.beforeAll(async () => {
  await seedInstance(); // so /login doesn't bounce to /setup
});

const policyOf = (res: { headers: Headers }) => res.headers.get("content-security-policy")!;
const nonceOf = (policy: string) => policy.match(/script-src[^;]*'nonce-([^']+)'/)![1];
const scriptTags = (html: string) => html.match(/<script\b[^>]*>/g) ?? [];

const PAGES = ["/login", "/setup", "/no-such-page"]; // /setup redirects once set up; the redirect carries it too

test.describe("pages", () => {
  for (const path of PAGES) {
    test(`${path}: the policy is present, strict, and has no way to run an inline script`, async () => {
      const res = await api(path);
      const policy = policyOf(res);
      expect(policy, "no Content-Security-Policy").toBeTruthy();
      expect(policy).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'(;|$)/);
      expect(policy).not.toMatch(/unsafe-inline|unsafe-eval/);
      for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
        expect(policy).toContain(d);
      }
      expect(res.headers.get("content-security-policy-report-only")).toBeNull(); // enforcing by default
    });
  }

  test("every <script> in the HTML carries THIS response's nonce — inline ones included", async () => {
    const res = await api("/login");
    const nonce = nonceOf(policyOf(res));
    const tags = scriptTags(res.text);
    expect(tags.length).toBeGreaterThan(3);
    for (const tag of tags) expect(tag, tag).toContain(`nonce="${nonce}"`);
    expect(tags.some((t) => !t.includes(" src=")), "expected Next's inline bootstrap scripts").toBe(true);
  });

  test("no inline <style> blocks or style=\"\" attributes (so style-src needs only the nonce)", async () => {
    const { text } = await api("/login");
    expect(text).not.toMatch(/<style\b(?![^>]*nonce=)/);
    expect(text).not.toMatch(/\sstyle="/);
  });

  test("the nonce is different on every request, and never appears in a cached form", async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 12; i++) nonces.add(nonceOf(policyOf(await api("/login"))));
    expect(nonces.size).toBe(12);
    expect((await api("/login")).headers.get("cache-control")).toContain("no-store");
  });

  test("the nonce in the HTML is the nonce in the header, not a stale one", async () => {
    const a = await api("/login");
    const b = await api("/login");
    expect(nonceOf(policyOf(a))).not.toBe(nonceOf(policyOf(b)));
    expect(b.text).not.toContain(nonceOf(policyOf(a)));
  });

  test("the policy survives a redirect response too", async () => {
    const res = await api("/dashboard"); // signed out → 307 to /login
    expect(res.status).toBe(307);
    expect(policyOf(res)).toContain("script-src");
  });
});

test.describe("the JSON API and static assets", () => {
  test("API responses carry the static 'load nothing, never framed' policy", async () => {
    for (const path of ["/api/v1/auth/me", "/api/v1/auth/login"]) {
      const res = await api(path);
      expect(policyOf(res), path).toBe("default-src 'none'; frame-ancestors 'none'");
    }
  });

  test("static assets are not run through the proxy (no per-request policy on a file)", async () => {
    expect((await api("/favicon.ico")).headers.get("content-security-policy")).toBeNull();
  });
});

test.describe("upgrade-insecure-requests follows the deployment's scheme", () => {
  test("absent on the plain-HTTP deployment — it would make the browser rewrite every sub-request to https", async () => {
    expect(policyOf(await api("/login"))).not.toContain("upgrade-insecure-requests");
  });

  test("present on the https deployment (APP_URL=https://…)", async () => {
    const res = await api("/login", { baseUrl: `http://localhost:${HTTPS_APP_PORT}` });
    expect(policyOf(res)).toContain("upgrade-insecure-requests");
    expect(policyOf(res)).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  });
});
