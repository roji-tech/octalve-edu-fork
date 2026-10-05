import "../support/env";
import crypto from "node:crypto";
import Redis from "ioredis";
import { test, expect } from "@playwright/test";
import { TEST_REDIS_URL } from "../support/env";
import { withEnv } from "../support/with-env";
import {
  checkRateLimit, connectRedis, createMemoryStore, createRedisStore, createResilientStore, refundAttempt,
  reserveAttempt, resetRateLimitStoreForTests, type RateLimitStore,
} from "@/lib/auth/rate-limit";

// One conformance suite for BOTH stores (plan §0.5.3, D): the Redis store must behave exactly like the memory store,
// so swapping them for a multi-instance deployment changes nothing a caller can observe. Redis tests run against a
// real server (started by playwright.config.ts).

const key = (label: string) => `t:${label}:${crypto.randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let redis: Redis;
test.beforeAll(async () => {
  redis = connectRedis(TEST_REDIS_URL);
  await redis.connect();
  await redis.ping();
});
test.afterAll(async () => {
  await redis.quit();
});

const WINDOW = 400; // a short window so expiry is testable in real time
const stores: [string, () => RateLimitStore][] = [
  ["memory", () => createMemoryStore({ windowMs: WINDOW })],
  ["redis", () => createRedisStore(redis, { windowMs: WINDOW })],
];

for (const [name, make] of stores) {
  test.describe(`${name} store`, () => {
    test("allows exactly `limit` reservations, then refuses — and a refusal takes nothing", async () => {
      const store = make();
      const id = key("limit");
      const results: boolean[] = [];
      for (let i = 0; i < 7; i++) results.push(await store.reserve(id, 5));
      expect(results).toEqual([true, true, true, true, true, false, false]);
      expect(await store.count(id)).toBe(5);
    });

    test("keys are independent", async () => {
      const store = make();
      const a = key("a");
      const b = key("b");
      for (let i = 0; i < 3; i++) await store.reserve(a, 3);
      expect(await store.reserve(a, 3)).toBe(false);
      expect(await store.reserve(b, 3)).toBe(true);
    });

    test("refund hands back a slot; refunding an empty key is a harmless no-op; it can't go below zero", async () => {
      const store = make();
      const id = key("refund");
      await store.refund(id);
      expect(await store.count(id)).toBe(0);
      for (let i = 0; i < 3; i++) await store.reserve(id, 3);
      expect(await store.reserve(id, 3)).toBe(false);
      await store.refund(id);
      expect(await store.count(id)).toBe(2);
      expect(await store.reserve(id, 3)).toBe(true);
      for (let i = 0; i < 6; i++) await store.refund(id);
      expect(await store.count(id)).toBe(0);
    });

    test("refund removes the NEWEST slot, so the window still ends when the oldest attempts age out", async () => {
      const store = make();
      const id = key("newest");
      await store.reserve(id, 2); // old
      await sleep(WINDOW * 0.6);
      await store.reserve(id, 2); // new
      await store.refund(id); // …hand back the new one
      await sleep(WINDOW * 0.5); // the OLD one is now past the window; had the old one been refunded instead, the new one would remain
      expect(await store.count(id)).toBe(0);
    });

    test("the window slides: a slot is free again once its own attempt is older than the window", async () => {
      const store = make();
      const id = key("window");
      expect(await store.reserve(id, 1)).toBe(true);
      expect(await store.reserve(id, 1)).toBe(false);
      await sleep(WINDOW + 150);
      expect(await store.reserve(id, 1)).toBe(true);
    });

    test("a refused reservation does not extend the lockout", async () => {
      const store = make();
      const id = key("no-extend");
      await store.reserve(id, 1);
      await sleep(WINDOW * 0.7);
      expect(await store.reserve(id, 1)).toBe(false); // hammering while locked out…
      await sleep(WINDOW * 0.5);
      expect(await store.reserve(id, 1)).toBe(true); // …did not push the end out
    });

    test("limit 0 allows nothing; limit 1 allows one", async () => {
      const store = make();
      expect(await store.reserve(key("zero"), 0)).toBe(false);
      const one = key("one");
      expect(await store.reserve(one, 1)).toBe(true);
      expect(await store.reserve(one, 1)).toBe(false);
    });

    test("CONCURRENT reservations: 60 at once against limit 5 → exactly 5 succeed", async () => {
      const store = make();
      const id = key("race");
      const results = await Promise.all(Array.from({ length: 60 }, () => store.reserve(id, 5)));
      expect(results.filter(Boolean)).toHaveLength(5);
    });

    test("odd identifiers are just keys (colons, unicode, spaces, very long)", async () => {
      const store = make();
      for (const id of [`a:b:c:${crypto.randomUUID()}`, `ünï-${crypto.randomUUID()}-名前`, `with space ${crypto.randomUUID()}`, "x".repeat(2000) + crypto.randomUUID()]) {
        expect(await store.reserve(id, 1)).toBe(true);
        expect(await store.reserve(id, 1)).toBe(false);
      }
    });
  });
}

test.describe("memory store", () => {
  test("is size-capped: the stalest identifiers go first, a hot one survives", async () => {
    const store = createMemoryStore({ maxTracked: 5 });
    const hot = key("hot");
    await store.reserve(hot, 3);
    for (let i = 0; i < 20; i++) {
      await store.reserve(`junk:${i}`, 3);
      await store.reserve(hot, 3); // keeps being touched
    }
    expect(await store.count(hot)).toBe(3);
    expect(await store.count("junk:0")).toBe(0);
  });
});

test.describe("redis store: what only a SHARED store can do", () => {
  test("two instances (two stores, one Redis) share ONE limit — the whole point of the store", async () => {
    const one = createRedisStore(connectRedis(TEST_REDIS_URL), { windowMs: 60_000 });
    const two = createRedisStore(connectRedis(TEST_REDIS_URL), { windowMs: 60_000 });
    const id = key("shared");
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? one : two).reserve(id, 7)));
    expect(results.filter(Boolean)).toHaveLength(7);
    expect(await one.count(id)).toBe(7);
    expect(await two.count(id)).toBe(7);
    await two.refund(id);
    expect(await one.count(id)).toBe(6); // a refund on one instance is seen by the other
  });

  test("keys expire by themselves (no leak) and live under the rl: prefix", async () => {
    const store = createRedisStore(redis, { windowMs: 2_000 });
    const id = key("ttl");
    await store.reserve(id, 3);
    const ttl = await redis.pttl(`rl:${id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2_000);
    expect(await redis.exists(id)).toBe(0); // never an un-prefixed key
  });
});

test.describe("fallback when Redis is unreachable", () => {
  test("the limit STILL holds (in this process's memory), the outage is logged ONCE, and Redis is used again when it returns", async () => {
    const dead = connectRedis("redis://127.0.0.1:6399"); // nothing listens here
    const live = { current: createRedisStore(dead, { windowMs: 60_000 }) };
    const switchable: RateLimitStore = {
      reserve: (i, l) => live.current.reserve(i, l),
      refund: (i) => live.current.refund(i),
      count: (i) => live.current.count(i),
    };
    const store = createResilientStore(switchable, createMemoryStore({ windowMs: 60_000 }), { cooldownMs: 100 });
    const errors: unknown[][] = [];
    const warnings: unknown[][] = [];
    const [origError, origWarn] = [console.error, console.warn];
    console.error = (...a: unknown[]) => void errors.push(a);
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      const id = key("outage");
      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) results.push(await store.reserve(id, 3));
      expect(results).toEqual([true, true, true, false, false]); // never "no limit"
      await store.refund(id);
      expect(await store.count(id)).toBe(2);
      expect(errors).toHaveLength(1); // once per outage, not once per request
      expect(String(errors[0][0])).toContain("Redis unavailable");

      live.current = createRedisStore(redis, { windowMs: 60_000 }); // Redis "comes back"
      await sleep(150); // …and the breaker's cooldown passes
      expect(await store.reserve(key("back"), 1)).toBe(true);
      expect(warnings.map((w) => String(w[0])).join(" ")).toContain("reachable again");
    } finally {
      [console.error, console.warn] = [origError, origWarn];
      dead.disconnect();
    }
  });

  test("while Redis STAYS down, re-probing after each cooldown does not log again — one line per outage", async () => {
    const dead = connectRedis("redis://127.0.0.1:6399");
    const store = createResilientStore(createRedisStore(dead), createMemoryStore(), { cooldownMs: 50 });
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      for (let i = 0; i < 3; i++) {
        await store.reserve(key("probe"), 5);
        await sleep(80); // the cooldown passes, so the next call probes Redis again — and fails again
      }
      expect(errors).toHaveLength(1);
    } finally {
      console.error = orig;
      dead.disconnect();
    }
  });

  test("a dead Redis costs ONE slow request per cooldown, not one per request", async () => {
    const dead = connectRedis("redis://127.0.0.1:6399");
    const store = createResilientStore(createRedisStore(dead), createMemoryStore(), { cooldownMs: 60_000 });
    const orig = console.error;
    console.error = () => undefined;
    try {
      const started = Date.now();
      await store.reserve(key("slow"), 1);
      expect(Date.now() - started).toBeLessThan(2_500);
      const next = Date.now();
      for (let i = 0; i < 20; i++) await store.reserve(key("fast"), 1); // the breaker is open: straight to memory
      expect(Date.now() - next).toBeLessThan(200);
    } finally {
      console.error = orig;
      dead.disconnect();
    }
  });
});

test.describe("choosing the store from the environment", () => {
  test.afterEach(() => resetRateLimitStoreForTests());

  test("default: memory — nothing is written to Redis", async () => {
    await withEnv({ RATE_LIMIT_STORE: undefined, REDIS_URL: TEST_REDIS_URL }, async () => {
      resetRateLimitStoreForTests();
      const id = key("default");
      expect(await reserveAttempt(id, 1)).toBe(true);
      expect(await reserveAttempt(id, 1)).toBe(false);
      expect(await redis.exists(`rl:${id}`)).toBe(0);
    });
  });

  test("RATE_LIMIT_STORE=redis: reserve, refund and check go through Redis and are shared", async () => {
    await withEnv({ RATE_LIMIT_STORE: "redis", REDIS_URL: TEST_REDIS_URL }, async () => {
      resetRateLimitStoreForTests();
      const id = key("env-redis");
      expect(await reserveAttempt(id, 2)).toBe(true);
      expect(await redis.zcard(`rl:${id}`)).toBe(1);
      expect(await checkRateLimit(id, 2)).toBe(true);
      expect(await reserveAttempt(id, 2)).toBe(true);
      expect(await checkRateLimit(id, 2)).toBe(false);
      await refundAttempt(id);
      expect(await redis.zcard(`rl:${id}`)).toBe(1);
    });
  });

  test("redis without a REDIS_URL is a loud configuration error, not a silent memory fallback", async () => {
    await withEnv({ RATE_LIMIT_STORE: "redis", REDIS_URL: undefined }, async () => {
      resetRateLimitStoreForTests();
      await expect(reserveAttempt(key("nourl"), 1)).rejects.toThrow(/REDIS_URL/);
    });
  });

  test("a SaaS production deployment on the memory store warns, once", async () => {
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      await withEnv({ RATE_LIMIT_STORE: undefined, NODE_ENV: "production", DEPLOYMENT_MODE: "saas" }, async () => {
        resetRateLimitStoreForTests();
        await reserveAttempt(key("w1"), 1);
        resetRateLimitStoreForTests(); // (a second selection in the same process must not warn again… until reset)
      });
      expect(warnings.filter((w) => String(w[0]).includes("[RATE_LIMIT] SaaS"))).toHaveLength(1);
      await withEnv({ RATE_LIMIT_STORE: undefined, NODE_ENV: "production", DEPLOYMENT_MODE: "solo" }, async () => {
        resetRateLimitStoreForTests();
        await reserveAttempt(key("w2"), 1);
      });
      expect(warnings.filter((w) => String(w[0]).includes("[RATE_LIMIT] SaaS"))).toHaveLength(1); // Solo never warns
    } finally {
      console.warn = orig;
    }
  });
});
