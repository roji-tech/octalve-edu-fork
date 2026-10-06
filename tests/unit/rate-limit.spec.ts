import "../support/env";
import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { MAX_TRACKED_IDENTIFIERS, checkRateLimit, getClientIp, refundAttempt, reserveAttempt } from "@/lib/auth/rate-limit";

const WINDOW_MS = 5 * 60 * 1000;
const key = (label: string) => `test:${label}:${crypto.randomUUID()}`;

/// Time is the one thing the limiter reads implicitly (Date.now), so tests
/// drive it with a fake clock and restore the real one afterwards.
async function withClock(fn: (clock: { advance(ms: number): void }) => Promise<void>) {
  const realNow = Date.now;
  let now = realNow.call(Date);
  Date.now = () => now;
  try {
    await fn({ advance: (ms) => void (now += ms) });
  } finally {
    Date.now = realNow;
  }
}

test.describe("reserve-then-refund limiter", () => {
  test("allows exactly `limit` reservations, then refuses", async () => {
    const id = key("limit");
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) results.push(await reserveAttempt(id, 5));
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  test("a refused reservation does not extend the lockout", async () => {
    await withClock(async ({ advance }) => {
      const id = key("no-extend");
      for (let i = 0; i < 5; i++) await reserveAttempt(id, 5);
      advance(WINDOW_MS - 1_000);
      expect(await reserveAttempt(id, 5)).toBe(false); // hammering while locked out…
      advance(2_000); // …must not push the window's end out
      expect(await reserveAttempt(id, 5)).toBe(true);
    });
  });

  test("the window slides: attempts expire individually", async () => {
    await withClock(async ({ advance }) => {
      const id = key("slide");
      await reserveAttempt(id, 5);
      await reserveAttempt(id, 5); // two at t=0
      advance(4 * 60 * 1000);
      await reserveAttempt(id, 5);
      await reserveAttempt(id, 5);
      await reserveAttempt(id, 5); // three at t=4min -> full
      expect(await reserveAttempt(id, 5)).toBe(false);
      advance(61 * 1000); // t=5m01s: the first two have aged out, the last three haven't
      expect(await reserveAttempt(id, 5)).toBe(true);
      expect(await reserveAttempt(id, 5)).toBe(true);
      expect(await reserveAttempt(id, 5)).toBe(false);
    });
  });

  test("refund hands back exactly the most recent reservation", async () => {
    const id = key("refund");
    for (let i = 0; i < 5; i++) await reserveAttempt(id, 5);
    expect(await reserveAttempt(id, 5)).toBe(false);
    await refundAttempt(id);
    expect(await reserveAttempt(id, 5)).toBe(true);
    expect(await reserveAttempt(id, 5)).toBe(false);
  });

  test("refunding an unknown or empty key is a harmless no-op", async () => {
    const id = key("refund-empty");
    await refundAttempt(id);
    expect(await reserveAttempt(id, 1)).toBe(true);
    await refundAttempt(id);
    await refundAttempt(id); // already empty
    expect(await reserveAttempt(id, 1)).toBe(true);
  });

  test("checkRateLimit reads without reserving", async () => {
    const id = key("check");
    for (let i = 0; i < 20; i++) expect(await checkRateLimit(id, 2)).toBe(true);
    await reserveAttempt(id, 5);
    await reserveAttempt(id, 5);
    expect(await checkRateLimit(id, 2)).toBe(false);
    expect(await checkRateLimit(id, 3)).toBe(true);
  });

  test("keys are independent", async () => {
    const a = key("indep-a");
    const b = key("indep-b");
    for (let i = 0; i < 5; i++) await reserveAttempt(a, 5);
    expect(await reserveAttempt(a, 5)).toBe(false);
    expect(await reserveAttempt(b, 5)).toBe(true);
  });

  test("concurrent reservations are atomic: 50 racers, exactly `limit` win", async () => {
    // Guards the file's stated invariant (no `await` inside reserveAttempt). If
    // someone adds one, every racer passes the count check before any records.
    const id = key("race");
    const results = await Promise.all(Array.from({ length: 50 }, () => reserveAttempt(id, 5)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
});

test.describe("bounded memory (LRU eviction)", () => {
  test("evicts the stalest keys past the cap and keeps a hot key", async () => {
    const hot = key("hot");
    const stale = key("stale");
    await reserveAttempt(stale, 1);
    await reserveAttempt(hot, 1);

    // Fill well past the cap with one-off keys (an attacker cycling identifiers),
    // re-touching the hot key along the way like a real, active user.
    for (let i = 0; i < MAX_TRACKED_IDENTIFIERS + 500; i++) {
      await reserveAttempt(`test:flood:${i}:${crypto.randomUUID()}`, 1);
      if (i % 1000 === 0) {
        await refundAttempt(hot);
        await reserveAttempt(hot, 1);
      }
    }

    // A key still tracked reads as "at its limit of 1"; an evicted one reads as fresh.
    expect(await checkRateLimit(stale, 1)).toBe(true); // evicted
    expect(await checkRateLimit(hot, 1)).toBe(false); // survived
  });
});

test.describe("getClientIp — only ever trusts what the proxy sets", () => {
  const withEnv = async (env: Record<string, string | undefined>, fn: () => void | Promise<void>) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

  test("default: reads x-real-ip and ignores a spoofed X-Forwarded-For", async () => {
    await withEnv({ CLIENT_IP_HEADER: undefined, TRUSTED_PROXY_HOPS: undefined }, () => {
      expect(getClientIp(req({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("203.0.113.7");
      // The client-controlled header alone must NOT be believed.
      expect(getClientIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBe("unproxied");
    });
  });

  test("x-forwarded-for mode: takes the Nth entry from the RIGHT, never the spoofable left", async () => {
    await withEnv({ CLIENT_IP_HEADER: "x-forwarded-for", TRUSTED_PROXY_HOPS: "1" }, () => {
      // client sent "6.6.6.6"; our one proxy appended the real peer
      expect(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.9" }))).toBe("198.51.100.9");
    });
    await withEnv({ CLIENT_IP_HEADER: "x-forwarded-for", TRUSTED_PROXY_HOPS: "2" }, () => {
      // CDN -> proxy: the client's own entry is second from the right
      expect(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.9, 10.0.0.1" }))).toBe("198.51.100.9");
    });
  });

  test("x-forwarded-for mode: fewer entries than trusted hops => unproxied (never guess)", async () => {
    await withEnv({ CLIENT_IP_HEADER: "x-forwarded-for", TRUSTED_PROXY_HOPS: "3" }, () => {
      expect(getClientIp(req({ "x-forwarded-for": "198.51.100.9" }))).toBe("unproxied");
    });
  });

  test("no usable header => one shared 'unproxied' bucket; oversize and whitespace are bounded", async () => {
    await withEnv({ CLIENT_IP_HEADER: undefined }, () => {
      expect(getClientIp(req({}))).toBe("unproxied");
      expect(getClientIp(req({ "x-real-ip": "   " }))).toBe("unproxied");
      expect(getClientIp(req({ "x-real-ip": "  203.0.113.7  " }))).toBe("203.0.113.7");
      expect(getClientIp(req({ "x-real-ip": "9".repeat(500) }))).toHaveLength(64);
    });
  });

  test("the configured header name is case-insensitive", async () => {
    await withEnv({ CLIENT_IP_HEADER: "X-Client-IP" }, () => {
      expect(getClientIp(req({ "x-client-ip": "203.0.113.50" }))).toBe("203.0.113.50");
    });
  });
});
