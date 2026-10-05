import "../support/env";
import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { validateCSRF } from "@/lib/auth/csrf";
import { withEnv } from "../support/with-env";

// The CSRF decision table (plan §0.5.3, C): Sec-Fetch-Site as a second signal, and X-Forwarded-Host trusted only
// when the operator says a proxy sets it.

function req(headers: Record<string, string>, url = "http://app.test:3000/api/v1/thing") {
  return new NextRequest(url, { method: "POST", headers });
}
const SELF = "http://app.test:3000";
const EVIL = "https://evil.example";

test.describe("Origin / Referer against the request's own host", () => {
  test("same origin passes; another origin, an unparseable one, and 'nothing at all' are refused", () => {
    expect(validateCSRF(req({ host: "app.test:3000", origin: SELF }))).toBe(true);
    expect(validateCSRF(req({ host: "app.test:3000", origin: EVIL }))).toBe(false);
    expect(validateCSRF(req({ host: "app.test:3000", origin: "null" }))).toBe(false);
    expect(validateCSRF(req({ host: "app.test:3000", origin: "not a url" }))).toBe(false);
    expect(validateCSRF(req({ host: "app.test:3000" }))).toBe(false);
  });

  test("Referer is the fallback only when there is no Origin — and Origin wins when both are present", () => {
    expect(validateCSRF(req({ host: "app.test:3000", referer: `${SELF}/account` }))).toBe(true);
    expect(validateCSRF(req({ host: "app.test:3000", referer: `${EVIL}/x` }))).toBe(false);
    expect(validateCSRF(req({ host: "app.test:3000", origin: EVIL, referer: `${SELF}/account` }))).toBe(false);
    expect(validateCSRF(req({ host: "app.test:3000", origin: SELF, referer: `${EVIL}/x` }))).toBe(true);
  });

  test("a lookalike host is not the host (substring and prefix tricks)", () => {
    for (const origin of ["http://app.test:3000.evil.example", "http://evil-app.test:3000", "http://app.test:30000", "http://app.test"]) {
      expect(validateCSRF(req({ host: "app.test:3000", origin })), origin).toBe(false);
    }
  });

  test("with no Host header the URL's own host is used (a request built in-process)", () => {
    expect(validateCSRF(req({ origin: SELF }))).toBe(true);
    expect(validateCSRF(req({ origin: EVIL }))).toBe(false);
  });
});

test.describe("Sec-Fetch-Site", () => {
  test("same-origin and none pass; cross-site and same-site are REFUSED even with a matching Origin", () => {
    const base = { host: "app.test:3000", origin: SELF };
    expect(validateCSRF(req({ ...base, "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(validateCSRF(req({ ...base, "sec-fetch-site": "none" }))).toBe(true);
    expect(validateCSRF(req({ ...base, "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(validateCSRF(req({ ...base, "sec-fetch-site": "same-site" }))).toBe(false); // a sibling subdomain
    expect(validateCSRF(req({ ...base, "sec-fetch-site": "" }))).toBe(false); // present but empty is not 'absent'
    expect(validateCSRF(req({ ...base, "sec-fetch-site": "something-new" }))).toBe(false);
  });

  test("it never RESCUES a request: same-origin with a foreign Origin is still refused; absent falls back to Origin", () => {
    expect(validateCSRF(req({ host: "app.test:3000", origin: EVIL, "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(validateCSRF(req({ host: "app.test:3000", "sec-fetch-site": "same-origin" }))).toBe(false); // no Origin/Referer at all
    expect(validateCSRF(req({ host: "app.test:3000", origin: SELF }))).toBe(true); // header absent entirely
  });
});

test.describe("X-Forwarded-Host", () => {
  const forged = { host: "app.test:3000", "x-forwarded-host": "evil.example", origin: EVIL };

  test("is IGNORED by default — a client cannot pick the host its own Origin is compared with", async () => {
    await withEnv({ TRUST_FORWARDED_HOST: undefined }, () => {
      expect(validateCSRF(req(forged))).toBe(false);
      expect(validateCSRF(req({ ...forged, "x-forwarded-host": "app.test:3000", origin: SELF }))).toBe(true); // Host decides, and it matches
    });
    await withEnv({ TRUST_FORWARDED_HOST: "false" }, () => expect(validateCSRF(req(forged))).toBe(false));
    await withEnv({ TRUST_FORWARDED_HOST: "TRUE" }, () => expect(validateCSRF(req(forged))).toBe(false)); // exactly "true"
  });

  test("is used when the operator says a proxy sets it", async () => {
    await withEnv({ TRUST_FORWARDED_HOST: "true" }, () => {
      // Behind a proxy: the app sees its own internal Host, the browser's Origin is the public one.
      expect(validateCSRF(req({ host: "127.0.0.1:3101", "x-forwarded-host": "school.example", origin: "https://school.example" }))).toBe(true);
      expect(validateCSRF(req({ host: "127.0.0.1:3101", "x-forwarded-host": "school.example", origin: EVIL }))).toBe(false);
      expect(validateCSRF(req({ host: "app.test:3000", origin: SELF }))).toBe(true); // no forwarded header → Host
    });
  });
});
