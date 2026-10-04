import type { Page } from "@playwright/test";
import { expect } from "../support/fixtures";

/// Alerts in the page's <main>. Next.js also renders its own (empty)
/// `<next-route-announcer role="alert">` outside <main>, so a bare
/// getByRole("alert") is ambiguous.
export const alerts = (page: Page) => page.getByRole("main").getByRole("alert");

/// The alert containing `text` (a page can show several, e.g. the HTTP warning plus an error).
export const alertWith = (page: Page, text: string | RegExp) => alerts(page).filter({ hasText: text });

export const emailField = (page: Page) => page.getByLabel("Email address", { exact: true });
export const passwordField = (page: Page) => page.getByLabel("Password", { exact: true });
export const signInButton = (page: Page) => page.getByRole("button", { name: "Sign in", exact: true });
/// The "Keep me signed in on this device" checkbox (unchecked by default).
export const keepSignedInBox = (page: Page) => page.getByLabel("Keep me signed in on this device");

export async function fillCredentials(page: Page, email: string, password: string) {
  await emailField(page).fill(email);
  await passwordField(page).fill(password);
}

/// `remember: true` ticks "Keep me signed in" first (a persistent cookie + the long policy);
/// the default leaves it as the screen does — unchecked (a session cookie + a 12-hour cap).
export async function signInThroughUi(
  page: Page,
  user: { email: string; password: string },
  opts: { remember?: boolean } = {},
) {
  await page.goto("/login");
  await fillCredentials(page, user.email, user.password);
  if (opts.remember) await keepSignedInBox(page).check();
  await signInButton(page).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/// Signs out through whatever this repo's signed-in screens offer: a "Sign out" button in the header
/// (Octalve Edu, until its app shell arrives with §0.5.2) or the account menu of the app shell
/// (AlEemaan; on a phone too — the avatar menu is in the top bar at every width).
export async function signOut(page: Page) {
  const direct = page.getByRole("button", { name: "Sign out" });
  const menu = page.getByRole("button", { name: /^Account menu for/ });
  await expect(direct.or(menu)).toBeVisible();
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "Sign out" }).click();
}

// --- Two-step verification (plan §0.5.D) -------------------------------------------------------------------
export const codeField = (page: Page) => page.getByLabel("Authentication code");
export const recoveryField = (page: Page) => page.getByLabel("Recovery code");
export const verifyButton = (page: Page) => page.getByRole("button", { name: "Verify", exact: true });
export const mfaHeading = (page: Page) => page.getByRole("heading", { level: 1, name: "Two-step verification" });

/// Signs in through BOTH steps: password, then a code (`{ code }`) or a recovery code (`{ recoveryCode }`).
export async function signInWithSecondFactor(
  page: Page,
  user: { email: string; password: string },
  factor: { code: string } | { recoveryCode: string },
  opts: { remember?: boolean } = {},
) {
  await page.goto("/login");
  await fillCredentials(page, user.email, user.password);
  if (opts.remember) await keepSignedInBox(page).check();
  await signInButton(page).click();
  await expect(mfaHeading(page)).toBeVisible();
  if ("recoveryCode" in factor) {
    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await recoveryField(page).fill(factor.recoveryCode);
  } else {
    await codeField(page).fill(factor.code);
  }
  await verifyButton(page).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/// Requests the page makes to the login API, for "did it send anything?" checks.
export function trackLoginRequests(page: Page) {
  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/v1/auth/login")) requests.push(req.method());
  });
  return requests;
}
