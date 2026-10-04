import { test, expect } from "../support/fixtures";
import { seedInstance } from "../support/db";

// A real browser enforcing the policy (domain-implementation-plan.md §0.5.B). Every OTHER browser test
// is also a CSP test: the `csp` fixture fails any test during which the browser reported a violation.
// This file proves the fixture can see one at all, and that injected script really is inert.

test.beforeAll(async () => {
  await seedInstance();
});

// What an XSS bug actually does is get ATTACKER MARKUP into the HTML the server sends. So that is what is
// simulated: the real /login response, byte for byte — headers (including the real policy) and all — with a
// payload spliced in after <body>. (Not `page.evaluate(createElement("script"))`: with 'strict-dynamic',
// script created by already-trusted script is trusted by design, and DevTools-evaluated code is exempt
// anyway — that would test nothing about markup injection. First attempt at this test did exactly that
// and the "attack" ran.)
async function withInjectedMarkup(page: import("@playwright/test").Page, payload: string) {
  await page.route("**/login", async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(/<body[^>]*>/, (open) => open + payload);
    await route.fulfill({ response, body: html });
  });
}
const pwned = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as Record<string, unknown>).__pwned);

test.describe("the policy blocks what an XSS bug would inject", () => {
  test("an injected inline <script> does not run, and the browser reports it", async ({ page, csp }) => {
    await withInjectedMarkup(page, "<script>window.__pwned = 'inline script ran'</script>");
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to your dashboard" })).toBeVisible(); // the app still works
    expect(await pwned(page)).toBeUndefined();
    expect(csp.take().map((v) => v.directive)).toContain("script-src-elem");
  });

  test("an injected inline event handler (onerror=…) does not run either", async ({ page, csp }) => {
    await withInjectedMarkup(page, `<img src="/nope.png" onerror="window.__pwned='handler ran'">`);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to your dashboard" })).toBeVisible();
    expect(await pwned(page)).toBeUndefined();
    expect(csp.take().map((v) => v.directive)).toContain("script-src-attr");
  });

  test("an injected <script src> from another origin does not load", async ({ page, csp }) => {
    await withInjectedMarkup(page, `<script src="https://evil.example/x.js"></script>`);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to your dashboard" })).toBeVisible();
    expect(csp.take().map((v) => v.blocked)).toContain("https://evil.example/x.js");
  });

  test("an injected javascript: link does not run", async ({ page, csp }) => {
    await withInjectedMarkup(page, `<a id="evil" href="javascript:window.__pwned='js url ran'">x</a>`);
    await page.goto("/login");
    await page.locator("#evil").click();
    expect(await pwned(page)).toBeUndefined();
    expect(csp.take().length).toBeGreaterThan(0);
  });

  test("a <base> can't re-root the page's relative URLs (base-uri)", async ({ page, csp }) => {
    await page.goto("/login");
    await page.evaluate(() => {
      document.head.insertAdjacentHTML("beforeend", `<base href="https://evil.example/">`);
    });
    await expect.poll(() => csp.take().map((v) => v.directive)).toContain("base-uri");
  });
});

test.describe("and the app itself is unaffected", () => {
  test("hydration works (the nonced framework scripts ran): the theme toggle responds and there are no violations", async ({ page, csp }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(csp.take()).toEqual([]);
  });
});
