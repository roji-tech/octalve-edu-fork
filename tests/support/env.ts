// Shared constants and environment for every test process (the Playwright
// runner, each worker, and — via playwright.config.ts — the servers under test).
//
// Import this BEFORE anything from "@/lib/..." in a test: it points
// DATABASE_URL at the TEST database, so application code imported in-process
// (session lifecycle tests) can never touch the development database.

// Developer machines keep settings in .env; CI provides real env vars directly.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env — fine
}

/// TEST LANES: the suite is serial because it shares one database and a fixed block of ports. A LANE is an isolated copy of both — set
/// `TEST_LANE=1` (…9) and every port moves up by 10 × the lane (Redis by 1 × the lane) and the test database becomes
/// `<name>_lane<N>_test` — so several checkouts of the same source can run at once (see tests/README.md, "Lanes", and
/// scripts/lanes.mjs). Lane 0, the default, is exactly the old layout. Files (the outbox, test-results) are per checkout already.
const rawLane = process.env.TEST_LANE ?? "0";
if (!/^[0-9]$/.test(rawLane)) throw new Error(`TEST_LANE must be a single digit 0–9 (got "${rawLane}").`);
export const LANE = Number(rawLane);
const lanePort = (base: number) => base + LANE * 10;

/// The "inbox": EMAIL_TRANSPORT=file appends one JSON line per message here (see tests/support/outbox.ts).
export const EMAIL_FILE = `${process.cwd()}/tests/.tmp/outbox.jsonl`;

export const HTTP_PORT = lanePort(3100); // plain-HTTP app: APP_URL=http://localhost:3100 -> unprefixed cookie
export const HTTPS_APP_PORT = lanePort(3101); // same build, APP_URL=https://localhost:3443
export const TLS_PORT = lanePort(3443); // TLS-terminating reverse proxy in front of 3101

/// A FOURTH server: the same build in "staging" mode with the dev tools on and a token required, the one place
/// the dev email inbox exists (the other three are production-shaped and must show no trace of it).
export const DEVTOOLS_PORT = lanePort(3102);
export const DEV_TOOLS_TEST_TOKEN = "test-dev-tools-token-0123456789";

/// A FIFTH server: the same build in `DEPLOYMENT_MODE=saas`. The other servers are Solo (the whole install is one
/// school, and a second tenant is an invariant violation that fails closed), so everything that needs SEVERAL
/// schools in one database — the tenant boundary, the school picker — runs here.
export const SAAS_PORT = lanePort(3103);

/// A SIXTH server, deliberately misconfigured: the SaaS-mode build connected as the ADMIN (the table owner, which
/// bypasses row-level security) instead of `app_user`. It exists to prove `assertRlsEnforced()` is wired in — a
/// production process on such a connection must refuse to serve tenant data rather than serve it unprotected.
export const UNSAFE_RLS_PORT = lanePort(3105);

/// A stand-in for the breached-password range API (tests/support/pwned-stub.mjs); the SaaS-mode server checks against it.
export const PWNED_STUB_PORT = lanePort(3104);
export const PWNED_STUB_URL = `http://127.0.0.1:${PWNED_STUB_PORT}`;

/// A throwaway Redis for the rate-limit store tests (started by playwright.config.ts: `redis-server` must be on PATH,
/// or `docker compose up -d redis` provides one on 6380 — set TEST_REDIS_URL to use that instead).
export const REDIS_TEST_PORT = 6390 + LANE;
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? `redis://localhost:${REDIS_TEST_PORT}`;

export const HTTP_URL = `http://localhost:${HTTP_PORT}`;
export const SAAS_URL = `http://localhost:${SAAS_PORT}`;
export const UNSAFE_RLS_URL = `http://localhost:${UNSAFE_RLS_PORT}`;
export const DEVTOOLS_URL = `http://localhost:${DEVTOOLS_PORT}`;
export const HTTPS_URL = `https://localhost:${TLS_PORT}`;

/// The database tests run against — TWO connections, because the runtime role is the one under test (§0.5.2):
///   TEST_DATABASE_URL      the ADMIN: arranges fixtures across schools (`db` in support/db.ts), empties the database,
///                          runs `prisma migrate deploy`. Must bypass RLS (a superuser — the docker/CI default — or
///                          BYPASSRLS). Defaults to DIRECT_URL (else DATABASE_URL) with `_test` appended to the name.
///   TEST_APP_DATABASE_URL  the RUNTIME role `app_user`: what the servers under test and every in-process import of the
///                          app connect as — so tests exercise row-level security as production does.
/// (In a lane other than 0 the derived name carries the lane: see LANE above.)
/// Both are idempotent (a name already ending in `_test` is left alone), which matters because this module is evaluated
/// again inside every worker process, where DATABASE_URL has already been rewritten — so the results are written back
/// to the environment below.
function resolveTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  const base = explicit ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!base) {
    throw new Error("Set DIRECT_URL (or TEST_DATABASE_URL) — see .env.example.");
  }
  const url = new URL(base);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name.endsWith("_test")) {
    if (explicit) {
      throw new Error(`TEST_DATABASE_URL must name a database ending in "_test" (got "${name}").`);
    }
    // A lane's database is its own: `octalve_edu_lane2_test` — never the default lane's, never the development one.
    url.pathname = `/${name}${LANE > 0 ? `_lane${LANE}` : ""}_test`;
  }
  return url.toString();
}

export const TEST_DATABASE_URL = resolveTestDatabaseUrl();
export const TEST_DATABASE_NAME = decodeURIComponent(
  new URL(TEST_DATABASE_URL).pathname.replace(/^\//, ""),
);

/// The runtime role's credentials are fixed by the infrastructure (docker/postgres/init, `pnpm db:roles`).
export const APP_DB_ROLE = "app_user";
function resolveAppDatabaseUrl(): string {
  if (process.env.TEST_APP_DATABASE_URL) return process.env.TEST_APP_DATABASE_URL;
  const url = new URL(TEST_DATABASE_URL);
  url.username = APP_DB_ROLE;
  url.password = APP_DB_ROLE;
  return url.toString();
}
export const TEST_APP_DATABASE_URL = resolveAppDatabaseUrl();

// Written back so a worker re-evaluating this module gets the same answers.
process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
process.env.TEST_APP_DATABASE_URL = TEST_APP_DATABASE_URL;
// From here on, anything in this process that reads DATABASE_URL (the application, imported in-process) connects as the
// RUNTIME role, to the test database. Fixtures use `db` (the admin) explicitly.
process.env.DATABASE_URL = TEST_APP_DATABASE_URL;
process.env.DIRECT_URL = TEST_DATABASE_URL;
// The in-process (integration) tests exercise the plain-HTTP cookie shape; the
// https project has its own server with its own APP_URL.
process.env.APP_URL = HTTP_URL;
process.env.DEPLOYMENT_MODE = "solo";
process.env.EMAIL_TRANSPORT = "file";
process.env.EMAIL_FILE = EMAIL_FILE;
// No test talks to the public breach service (and its answers must not decide a test): the check is off everywhere
// except in the specs that exercise it with an injected fetcher.
process.env.PWNED_PASSWORD_CHECK = "off";
// In-process tests start from the safe default (a production-shaped environment with the dev tools off); a test
// about the dev tools sets what it needs for its own duration.
process.env.APP_ENV = "production";
process.env.DEV_TOOLS = "";
process.env.DEV_TOOLS_TOKEN = "";

/// A fixed key for two-step verification, so the in-process tests and both servers agree on it
/// (32 bytes, base64). Tests that need "no key" delete it from process.env for their own duration.
export const TEST_MFA_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MFA_ENCRYPTION_KEY = TEST_MFA_KEY;

/// Environment for the Next.js servers under test. Explicit and complete on
/// purpose: nothing from a developer's shell or .env may change what is tested.
export function serverEnv(appUrl: string): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...inherited,
    NODE_ENV: "production",
    DATABASE_URL: TEST_APP_DATABASE_URL,
    DIRECT_URL: TEST_DATABASE_URL,
    DEPLOYMENT_MODE: "solo",
    APP_URL: appUrl,
    CLIENT_IP_HEADER: "x-real-ip",
    TRUSTED_PROXY_HOPS: "1",
    SETUP_TOKEN: "",
    // Only the proxied deployment trusts X-Forwarded-Host (see httpsServerEnv); everything else compares with Host.
    TRUST_FORWARDED_HOST: "",
    PWNED_PASSWORD_CHECK: "off",
    EMAIL_TRANSPORT: "file",
    EMAIL_FILE,
    // Production-shaped, whatever the developer's own .env says: no dev tools on these servers.
    APP_ENV: "production",
    DEV_TOOLS: "",
    DEV_TOOLS_TOKEN: "",
  };
}

/// The TLS-proxy deployment: the proxy sets X-Forwarded-Host, so the operator says to trust it.
export function httpsServerEnv(): Record<string, string> {
  return { ...serverEnv(HTTPS_URL), TRUST_FORWARDED_HOST: "true" };
}

/// The multi-tenant server: production-shaped, `DEPLOYMENT_MODE=saas`.
export function saasServerEnv(): Record<string, string> {
  // The SaaS-shaped server also uses the shared Redis rate-limit store (the other servers use memory), so the store
  // is exercised end to end by every limit test that runs here.
  return { ...serverEnv(SAAS_URL), DEPLOYMENT_MODE: "saas", RATE_LIMIT_STORE: "redis", REDIS_URL: TEST_REDIS_URL, PWNED_PASSWORD_CHECK: "on", PWNED_PASSWORD_URL: `${PWNED_STUB_URL}/range/` };
}

/// The misconfigured server (see UNSAFE_RLS_PORT): SaaS-shaped, but its DATABASE_URL is the admin's — and no
/// ALLOW_RLS_BYPASS, so in production mode it must refuse tenant data.
export function unsafeRlsServerEnv(): Record<string, string> {
  return { ...serverEnv(UNSAFE_RLS_URL), DEPLOYMENT_MODE: "saas", DATABASE_URL: TEST_DATABASE_URL, ALLOW_RLS_BYPASS: "" };
}

/// The dev-tools server: staging mode, the token required, and NO EMAIL_TRANSPORT / RESEND_API_KEY — so mail
/// goes where the app sends it by default in that mode: the in-memory dev inbox.
export function devToolsServerEnv(): Record<string, string> {
  return {
    ...serverEnv(DEVTOOLS_URL),
    EMAIL_TRANSPORT: "",
    RESEND_API_KEY: "",
    APP_ENV: "staging",
    DEV_TOOLS: "true",
    DEV_TOOLS_TOKEN: DEV_TOOLS_TEST_TOKEN,
  };
}
