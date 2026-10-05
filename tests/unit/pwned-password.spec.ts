import "../support/env";
import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { BREACHED_MESSAGE, checkNewPasswordOnServer, isBreachedPassword } from "@/lib/auth/pwned-password";
import { withEnv } from "../support/with-env";

// The breached-password check (plan §0.5.3, F): k-anonymity, fail-open. `fetcher` is injected — no test talks to the
// public service.

const sha1 = (value: string) => crypto.createHash("sha1").update(value).digest("hex").toUpperCase();
const ON = { PWNED_PASSWORD_CHECK: "on" };

type Call = { url: string; headers: Record<string, string> };
function fetcherReturning(body: string, status = 200) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    calls.push({ url, headers: init.headers });
    return { ok: status >= 200 && status < 300, text: async () => body };
  };
  return { fetcher, calls };
}

test.describe("isBreachedPassword", () => {
  test("the published example: 'password' hashes to 5BAA6…, and that suffix in the answer means breached", async () => {
    expect(sha1("password")).toBe("5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
    const { fetcher } = fetcherReturning("0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n011053FD0102E94D6AE2F8B83D76FAF94F6:1");
    await withEnv(ON, async () => expect(await isBreachedPassword("password", { fetcher })).toBe(true));
  });

  test("ONLY the 5-character prefix leaves the server — never the password, never the rest of the hash", async () => {
    const { fetcher, calls } = fetcherReturning("");
    const secret = "my-very-private-passphrase-77";
    await withEnv(ON, async () => {
      await isBreachedPassword(secret, { fetcher, baseUrl: "https://breach.test/range/" });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://breach.test/range/${sha1(secret).slice(0, 5)}`);
    expect(calls[0].url).not.toContain(secret);
    expect(calls[0].url).not.toContain(sha1(secret).slice(5, 12));
    expect(calls[0].headers["Add-Padding"]).toBe("true");
  });

  test("a suffix with a count of 0 is PADDING, not a match; a different suffix is not a match; matching is case-insensitive", async () => {
    const suffix = sha1("padded").slice(5);
    await withEnv(ON, async () => {
      expect(await isBreachedPassword("padded", { fetcher: fetcherReturning(`${suffix}:0`).fetcher })).toBe(false);
      expect(await isBreachedPassword("padded", { fetcher: fetcherReturning(`${"A".repeat(35)}:50`).fetcher })).toBe(false);
      expect(await isBreachedPassword("padded", { fetcher: fetcherReturning(`${suffix.toLowerCase()}:4`).fetcher })).toBe(true);
      expect(await isBreachedPassword("padded", { fetcher: fetcherReturning(`junk\n\n:::\n${suffix}:2`).fetcher })).toBe(true); // odd lines are skipped
    });
  });

  test("FAILS OPEN: an error status, a thrown error, a timeout and an empty answer all mean 'not known to be breached'", async () => {
    await withEnv(ON, async () => {
      expect(await isBreachedPassword("pw", { fetcher: fetcherReturning("x", 500).fetcher })).toBe(false);
      expect(await isBreachedPassword("pw", { fetcher: fetcherReturning("x", 429).fetcher })).toBe(false);
      expect(await isBreachedPassword("pw", { fetcher: async () => { throw new Error("offline"); } })).toBe(false);
      expect(await isBreachedPassword("pw", { fetcher: fetcherReturning("").fetcher })).toBe(false);
      const hangs = (_url: string, init: { signal: AbortSignal }) => new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      const started = Date.now();
      expect(await isBreachedPassword("pw", { fetcher: hangs as never, timeoutMs: 150 })).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_500);
    });
  });

  test("PWNED_PASSWORD_CHECK=off never calls out", async () => {
    const { fetcher, calls } = fetcherReturning(`${sha1("password").slice(5)}:99`);
    await withEnv({ PWNED_PASSWORD_CHECK: "off" }, async () => expect(await isBreachedPassword("password", { fetcher })).toBe(false));
    expect(calls).toHaveLength(0);
  });
});

test.describe("checkNewPasswordOnServer", () => {
  test("the shape rule comes first (and needs no network); then the breach check", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(`${sha1("correct-horse-9").slice(5)}:12`); }) as typeof fetch;
    try {
      await withEnv(ON, async () => {
        expect(await checkNewPasswordOnServer("short1")).toMatch(/at least 8 characters/);
        expect(calls).toBe(0);
        expect(await checkNewPasswordOnServer("correct-horse-9")).toBe(BREACHED_MESSAGE);
        expect(await checkNewPasswordOnServer("a-fresh-unseen-passphrase-3")).toBeNull();
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
