import crypto from "node:crypto";
import { checkNewPassword } from "@/lib/auth/password-policy";

// Breached-password check (domain-implementation-plan.md §0.5.3, F): a password that already appears in public data
// breaches is refused when it is CHOSEN (setup, reset, change) — people reuse breached passwords, and credential
// stuffing is the attack the rate limits only slow down.
//
// k-anonymity (Have I Been Pwned's range API): only the FIRST FIVE hex characters of the password's SHA-1 leave this
// server; the service answers with every suffix sharing that prefix, and the match is made here. The password and its
// full hash are never sent. `Add-Padding: true` makes the response size reveal nothing about the prefix's popularity;
// padding rows have a count of 0 and are ignored.
//
// FAIL OPEN: any network error, timeout or odd answer means "not known to be breached" — a breach service being down
// must never stop a person setting a password (the shape rules still apply). `PWNED_PASSWORD_CHECK=off` disables the
// check (the test servers; an air-gapped Solo install).

export const BREACHED_MESSAGE = "That password has appeared in a data breach. Choose a different one.";

const DEFAULT_URL = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 2_000;

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;

export async function isBreachedPassword(
  password: string,
  options: { fetcher?: Fetcher; baseUrl?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  if (process.env.PWNED_PASSWORD_CHECK === "off") return false;
  const sha1 = crypto.createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const fetcher = options.fetcher ?? (fetch as unknown as Fetcher);
  const base = options.baseUrl ?? process.env.PWNED_PASSWORD_URL ?? DEFAULT_URL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetcher(`${base}${prefix}`, { headers: { "Add-Padding": "true", "User-Agent": "octalve-edu-password-check" }, signal: controller.signal });
    if (!res.ok) return false;
    for (const line of (await res.text()).split(/\r?\n/)) {
      const [candidate, count] = line.trim().split(":");
      if (candidate?.toUpperCase() === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/// The server-side rule for a NEW password: the shape rules (shared with the browser), then the breach check.
/// Returns the sentence to show, or null.
export async function checkNewPasswordOnServer(password: string): Promise<string | null> {
  const problem = checkNewPassword(password);
  if (problem) return problem;
  return (await isBreachedPassword(password)) ? BREACHED_MESSAGE : null;
}
