import "./env"; // must stay first: points DATABASE_URL at the test database
import { test as base, expect } from "@playwright/test";
import { uniqueIp } from "./db";

export type CspViolation = { directive: string; blocked: string; sample: string; page: string };

type Fixtures = {
  /// A client IP unique to this test. Sent as X-Real-IP (the header the servers
  /// under test trust for rate limiting) so tests can't exhaust each other's
  /// buckets. `x-test-client-ip` is the same value for the TLS proxy, which
  /// overwrites x-real-ip itself and promotes this header instead.
  clientIp: string;
  /// Every Content-Security-Policy violation the browser reported during this test (an auto fixture:
  /// it runs for every browser test). The test FAILS if any occurred — so each existing flow is also
  /// a CSP test, in both themes and on the https deployment. A test that deliberately provokes one
  /// calls `csp.take()`, which returns (and clears) what was seen so far.
  csp: { take(): CspViolation[] };
};

export const test = base.extend<Fixtures>({
  // (The callback is named `provide`, not Playwright's usual `use`, because
  // eslint-plugin-react-hooks mistakes anything called `use(...)` for React's hook.)
  clientIp: async ({}, provide) => {
    await provide(uniqueIp());
  },
  csp: [
    async ({ context }, provide) => {
      const seen: CspViolation[] = [];
      // A binding (not a window variable): it survives navigations and reaches every page and frame.
      await context.exposeFunction("__reportCspViolation", (v: CspViolation) => void seen.push(v));
      await context.addInitScript(() => {
        document.addEventListener(
          "securitypolicyviolation",
          (e) =>
            void (window as unknown as Record<string, (v: unknown) => void>).__reportCspViolation({
              directive: e.violatedDirective,
              blocked: e.blockedURI,
              sample: e.sample,
              page: location.pathname,
            }),
          true,
        );
      });
      await provide({ take: () => seen.splice(0) });
      expect(seen, "the browser reported Content-Security-Policy violations").toEqual([]);
    },
    { auto: true },
  ],
  context: async ({ context, clientIp }, provide) => {
    await context.setExtraHTTPHeaders({ "x-real-ip": clientIp, "x-test-client-ip": clientIp });
    await provide(context);
  },
});

export { expect };
