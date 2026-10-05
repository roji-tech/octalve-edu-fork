// Rate limiter: reserve-then-refund over a sliding window, behind a STORE (domain-implementation-plan.md §0.5.3, D).
// Ported from AlEemaan's fixed version (see that repo's docs/development-history/phases/phase-0.5.1.5-auth-rebuild.md)
// and hardened further: reserve-then-refund, trusted-proxy-header IP, size-capped.
//
// STORES. `memory` (the default) lives in this process — correct for Solo installs (one long-lived process) and a
// single-instance SaaS deployment. It is NOT sufficient for several instances: a request landing on another
// instance sees another Map, so the limit is multiplied by the instance count. `RATE_LIMIT_STORE=redis` +
// `REDIS_URL` selects the shared store: one atomic Lua script per reserve/refund over a sorted set, the SAME sliding
// window, so behaviour is identical (one conformance suite runs against both). If Redis is unreachable the call
// falls back to this process's memory store for as long as the outage lasts (logged once): never "no limit" — that
// would switch brute-force protection off exactly when someone is attacking — and never "everyone locked out".
// A production SaaS deployment still on the memory store logs a loud warning once.
//
// The functions are `async` from day one so that swapping stores changed no call site.
//
// INVARIANT (memory store): its bodies must stay synchronous (no `await`). An async function runs synchronously
// until its first await, which is what makes each reservation atomic in a single-threaded process — the actual fix
// for the check-then-record race (concurrent requests all passing a check before any of them recorded anything).
// Adding an await inside the memory store's reserve would silently reintroduce that race. (The Redis store gets
// the same guarantee from running the check and the record in ONE Lua script.)

import crypto from "node:crypto";
import Redis from "ioredis";

export const WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const MAX_TRACKED_IDENTIFIERS = 10_000; // hard cap — see sweep()

export interface RateLimitStore {
  /// Takes one slot for `identifier` unless it already holds `limit` within the window.
  reserve(identifier: string, limit: number): Promise<boolean>;
  /// Hands back the most recent slot (a successful attempt must not count against the person's future tries).
  refund(identifier: string): Promise<void>;
  /// How many slots are held right now — read-only.
  count(identifier: string): Promise<number>;
}

// --- memory ----------------------------------------------------------------------------------------------------------

export function createMemoryStore(options: { windowMs?: number; maxTracked?: number } = {}): RateLimitStore {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const maxTracked = options.maxTracked ?? MAX_TRACKED_IDENTIFIERS;
  const attempts = new Map<string, number[]>();

  /// Evicts the least-recently-touched identifiers once the map grows past the cap. Without a cap an attacker
  /// cycling through unique identifiers grows the Map forever. `touch()` re-inserts a key on every write, so Map
  /// insertion order == last-touched order and the first keys are the stalest — a hot legitimate key is never
  /// evicted ahead of a one-off attacker key.
  function sweep() {
    if (attempts.size <= maxTracked) return;
    const overflow = attempts.size - maxTracked;
    let removed = 0;
    for (const key of attempts.keys()) {
      attempts.delete(key);
      if (++removed >= overflow) break;
    }
  }

  function touch(identifier: string, recent: number[]) {
    attempts.delete(identifier); // delete-then-set moves the key to the end
    attempts.set(identifier, recent);
  }

  function recentCount(identifier: string): number {
    const since = Date.now() - windowMs;
    const recent = (attempts.get(identifier) ?? []).filter((t) => t > since);
    if (recent.length > 0) attempts.set(identifier, recent);
    else attempts.delete(identifier);
    return recent.length;
  }

  return {
    async reserve(identifier, limit) {
      const count = recentCount(identifier);
      if (count >= limit) return false;
      const recent = attempts.get(identifier) ?? [];
      recent.push(Date.now());
      touch(identifier, recent);
      sweep();
      return true;
    },
    async refund(identifier) {
      const recent = attempts.get(identifier);
      if (!recent || recent.length === 0) return;
      recent.pop();
      if (recent.length === 0) attempts.delete(identifier);
    },
    async count(identifier) {
      return recentCount(identifier);
    },
  };
}

// --- redis -----------------------------------------------------------------------------------------------------------

// Time comes from Redis itself (TIME), so instances with skewed clocks agree on the window. The sorted set holds one
// member per slot scored by its time; check-and-record is ONE script, so concurrent reserves from any number of
// instances cannot all pass the check before any of them records.
const RESERVE_LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - tonumber(ARGV[1]))
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1`;
const COUNT_LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - tonumber(ARGV[1]))
return redis.call('ZCARD', KEYS[1])`;

const KEY_PREFIX = "rl:";

export function createRedisStore(client: Redis, options: { windowMs?: number } = {}): RateLimitStore {
  const windowMs = options.windowMs ?? WINDOW_MS;
  return {
    async reserve(identifier, limit) {
      const result = await client.eval(RESERVE_LUA, 1, KEY_PREFIX + identifier, windowMs, limit, crypto.randomUUID());
      return result === 1;
    },
    async refund(identifier) {
      await client.zpopmax(KEY_PREFIX + identifier); // the newest slot, like the memory store's `pop()`
    },
    async count(identifier) {
      return Number(await client.eval(COUNT_LUA, 1, KEY_PREFIX + identifier, windowMs));
    },
  };
}

/// Redis first; this process's memory store while Redis is unreachable. Logs once per outage.
///
/// A small circuit breaker: after a failure Redis is not tried again for `cooldownMs`, so an outage costs ONE slow
/// request (up to the command timeout) per cooldown, not one per request. The first call after the cooldown is the
/// probe; if it succeeds Redis is back in use.
export function createResilientStore(primary: RateLimitStore, fallback: RateLimitStore, options: { cooldownMs?: number } = {}): RateLimitStore {
  const cooldownMs = options.cooldownMs ?? 5_000;
  let down = false;
  let retryAt = 0;
  async function attempt<T>(run: (store: RateLimitStore) => Promise<T>): Promise<T> {
    if (down && Date.now() < retryAt) return run(fallback);
    try {
      const result = await run(primary);
      if (down) {
        down = false;
        console.warn("[RATE_LIMIT] Redis is reachable again — using it.");
      }
      return result;
    } catch (error) {
      retryAt = Date.now() + cooldownMs;
      if (!down) {
        down = true;
        console.error(`[RATE_LIMIT] Redis unavailable (${error instanceof Error ? error.message : error}) — limiting in this process's memory until it returns.`);
      }
      return run(fallback);
    }
  }
  return {
    reserve: (identifier, limit) => attempt((store) => store.reserve(identifier, limit)),
    refund: (identifier) => attempt((store) => store.refund(identifier)),
    count: (identifier) => attempt((store) => store.count(identifier)),
  };
}

// --- selection ---------------------------------------------------------------------------------------------------------

/// Connects on first use and fails fast: one retry and short timeouts, so a dead Redis costs a request well under a
/// second before the memory fallback takes over (the offline queue stays ON — commands issued while the socket is
/// still connecting wait for it, instead of failing and sending the first requests of a fresh process to memory).
export function connectRedis(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 500,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
  client.on("error", () => undefined); // surfaced through the failing command; an unhandled 'error' event would crash the process
  return client;
}

let active: RateLimitStore | null = null;
let warnedMemoryInSaas = false;

function selectStore(): RateLimitStore {
  const memory = createMemoryStore();
  if (process.env.RATE_LIMIT_STORE === "redis") {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("RATE_LIMIT_STORE=redis needs REDIS_URL");
    return createResilientStore(createRedisStore(connectRedis(url)), memory);
  }
  if (!warnedMemoryInSaas && process.env.NODE_ENV === "production" && process.env.DEPLOYMENT_MODE === "saas") {
    warnedMemoryInSaas = true;
    console.warn("[RATE_LIMIT] SaaS deployment on the in-memory store: each instance counts separately, so the limits are multiplied by the instance count. Set RATE_LIMIT_STORE=redis and REDIS_URL before running more than one instance.");
  }
  return memory;
}

const store = (): RateLimitStore => (active ??= selectStore());

/// For tests: forget the chosen store so the next call re-reads the environment (and starts from empty memory).
export function resetRateLimitStoreForTests(): void {
  active = null;
  warnedMemoryInSaas = false;
}

/// Reserve-then-refund: call this at the very start of the handler, before any slow async work, for every key
/// that should gate the request. Returns false (reserving nothing further) the moment a key is already at its limit.
export async function reserveAttempt(
  identifier: string,
  limit: number = DEFAULT_MAX_ATTEMPTS,
): Promise<boolean> {
  return store().reserve(identifier, limit);
}

/// Call on a SUCCESSFUL attempt to hand back the reservation this request
/// made, so a correct login never counts against the user's own future tries.
export async function refundAttempt(identifier: string): Promise<void> {
  return store().refund(identifier);
}

/// Read-only check (does not reserve). Used for the soft per-account signal.
export async function checkRateLimit(
  identifier: string,
  limit: number = DEFAULT_MAX_ATTEMPTS,
): Promise<boolean> {
  return (await store().count(identifier)) < limit;
}

// --- Client IP -------------------------------------------------------------
//
// Only ever reads a header the reverse proxy itself sets, never the
// client-controlled leftmost X-Forwarded-For entry — that value costs an
// attacker nothing to spoof and is exactly what let the previous limiter be
// bypassed with a fresh fake IP per request (docs/auth-review-2026-09-29.md).
//
// Configure to match the deployment (both default to the nginx convention):
//   CLIENT_IP_HEADER    "x-real-ip" (default) — proxy overwrites it with the
//                       real peer address, e.g. nginx `proxy_set_header
//                       X-Real-IP $remote_addr`, or Caddy `header_up X-Real-IP
//                       {remote_host}`.
//                       "x-forwarded-for" — take the Nth entry from the RIGHT,
//                       where N = TRUSTED_PROXY_HOPS (default 1). Entries to
//                       the left of the trusted proxies' own are client-
//                       controlled and are never read.
//   TRUSTED_PROXY_HOPS  number of trusted proxies appending to
//                       X-Forwarded-For (default 1).
//
// No usable header (plain local dev, or a misconfigured proxy) falls back to
// ONE shared bucket. That is correct for local dev (one client) but in a
// deployment that really has many clients it turns the per-IP limit into a
// school-wide limit — so it warns once in production.

const MAX_IP_LENGTH = 64;
let warnedNoProxy = false;

function nthFromRight(value: string, hops: number): string | null {
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const index = parts.length - hops;
  return index >= 0 && index < parts.length ? parts[index] : null;
}

export function getClientIp(req: {
  headers: { get(name: string): string | null };
}): string {
  const header = (process.env.CLIENT_IP_HEADER ?? "x-real-ip").toLowerCase();
  const raw = req.headers.get(header);

  let ip: string | null = null;
  if (raw) {
    if (header === "x-forwarded-for") {
      const hops = Math.max(1, Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10) || 1);
      ip = nthFromRight(raw, hops);
    } else {
      ip = raw.trim();
    }
  }

  if (!ip) {
    if (!warnedNoProxy && process.env.NODE_ENV === "production") {
      warnedNoProxy = true;
      console.warn(
        `[RATE_LIMIT] No client IP in "${header}" — per-IP limits collapse into one shared bucket. ` +
          "Configure the reverse proxy to set it (see CLIENT_IP_HEADER in .env.example).",
      );
    }
    return "unproxied";
  }
  return ip.slice(0, MAX_IP_LENGTH);
}
