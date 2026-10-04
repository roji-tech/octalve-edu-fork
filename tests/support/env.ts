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

/// The "inbox": EMAIL_TRANSPORT=file appends one JSON line per message here (see tests/support/outbox.ts).
export const EMAIL_FILE = `${process.cwd()}/tests/.tmp/outbox.jsonl`;

export const HTTP_PORT = 3100; // plain-HTTP app: APP_URL=http://localhost:3100 -> unprefixed cookie
export const HTTPS_APP_PORT = 3101; // same build, APP_URL=https://localhost:3443
export const TLS_PORT = 3443; // TLS-terminating reverse proxy in front of 3101

export const HTTP_URL = `http://localhost:${HTTP_PORT}`;
export const HTTPS_URL = `https://localhost:${TLS_PORT}`;

/// The database tests run against: TEST_DATABASE_URL if set, otherwise the
/// developer's DATABASE_URL with `_test` appended to the database name. It is
/// idempotent (a name already ending in `_test` is left alone), which matters
/// because this module is evaluated again inside every worker process, where
/// DATABASE_URL has already been rewritten.
function resolveTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  const base = explicit ?? process.env.DATABASE_URL;
  if (!base) {
    throw new Error("Set DATABASE_URL (or TEST_DATABASE_URL) — see .env.example.");
  }
  const url = new URL(base);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name.endsWith("_test")) {
    if (explicit) {
      throw new Error(`TEST_DATABASE_URL must name a database ending in "_test" (got "${name}").`);
    }
    url.pathname = `/${name}_test`;
  }
  return url.toString();
}

export const TEST_DATABASE_URL = resolveTestDatabaseUrl();
export const TEST_DATABASE_NAME = decodeURIComponent(
  new URL(TEST_DATABASE_URL).pathname.replace(/^\//, ""),
);

// From here on, anything in this process that reads DATABASE_URL gets the test DB.
process.env.DATABASE_URL = TEST_DATABASE_URL;
// The in-process (integration) tests exercise the plain-HTTP cookie shape; the
// https project has its own server with its own APP_URL.
process.env.APP_URL = HTTP_URL;
process.env.DEPLOYMENT_MODE = "solo";
process.env.EMAIL_TRANSPORT = "file";
process.env.EMAIL_FILE = EMAIL_FILE;

/// Environment for the Next.js servers under test. Explicit and complete on
/// purpose: nothing from a developer's shell or .env may change what is tested.
export function serverEnv(appUrl: string): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...inherited,
    NODE_ENV: "production",
    DATABASE_URL: TEST_DATABASE_URL,
    DEPLOYMENT_MODE: "solo",
    APP_URL: appUrl,
    CLIENT_IP_HEADER: "x-real-ip",
    TRUSTED_PROXY_HOPS: "1",
    SETUP_TOKEN: "",
    EMAIL_TRANSPORT: "file",
    EMAIL_FILE,
  };
}
