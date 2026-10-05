import { defineConfig, devices } from "@playwright/test";
import {
  DEVTOOLS_PORT,
  DEVTOOLS_URL,
  HTTP_PORT,
  HTTP_URL,
  HTTPS_APP_PORT,
  HTTPS_URL,
  PWNED_STUB_PORT,
  REDIS_TEST_PORT,
  SAAS_PORT,
  SAAS_URL,
  TLS_PORT,
  UNSAFE_RLS_PORT,
  UNSAFE_RLS_URL,
  devToolsServerEnv,
  httpsServerEnv,
  saasServerEnv,
  serverEnv,
  unsafeRlsServerEnv,
} from "./tests/support/env";

// What runs where (see tests/README.md):
//   setup        creates/migrates/empties the *_test database (everything else needs it)
//   unit         pure logic, no database, no server
//   integration  application modules called in-process against the test database
//   api          real HTTP against a production build (`next start`) — login/logout/me
//   e2e-*        real Chromium against that same server, desktop and phone viewports
//   https        real Chromium over real TLS, so the `__Host-` cookie rules are enforced
//
// The servers are `next start` (a production build), not `next dev`: it is what
// ships, and dev mode changes cache headers and error behaviour. `pnpm test`
// builds first; `pnpm test:fast` reuses the existing build.
//
// One worker, no file-level parallelism: the suites share a database and the
// setup spec deliberately starts from an empty one. Each test creates its own
// users and its own client IP, so tests never depend on each other's data.
// More than one lane shares the machine's cores, and browser tests are CPU-bound: `TEST_TIMEOUT_SCALE` (set by scripts/lanes.mjs, 1 otherwise)
// stretches the TIMEOUTS in proportion — never an assertion, never a retry: a test that fails still fails, it just isn't blamed for the load.
const scale = Number(process.env.TEST_TIMEOUT_SCALE ?? "1") || 1;

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000 * scale,
  expect: { timeout: 5_000 * scale },
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0, // a flaky test is a bug to fix, not to retry away
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [["list"], ["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },

  webServer: [
    // The breached-password service stand-in (see tests/support/pwned-stub.mjs).
    { command: `node tests/support/pwned-stub.mjs ${PWNED_STUB_PORT}`, url: `http://127.0.0.1:${PWNED_STUB_PORT}/__requests`, reuseExistingServer: false, timeout: 20_000 },
    // A throwaway Redis (no persistence) for the rate-limit store tests — see tests/README.md. Skipped when the
    // developer points TEST_REDIS_URL at their own.
    ...(process.env.TEST_REDIS_URL
      ? []
      : [{ command: `redis-server --port ${REDIS_TEST_PORT} --save "" --appendonly no --bind 127.0.0.1`, port: REDIS_TEST_PORT, reuseExistingServer: false, timeout: 20_000 }]),
    {
      command: `pnpm exec next start -p ${HTTP_PORT}`,
      url: `${HTTP_URL}/favicon.ico`,
      env: serverEnv(HTTP_URL),
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The same build in "staging" mode with the dev tools on (and a token required): the only server with the
      // dev email inbox. The three production-shaped servers around it must 404 it and show nothing.
      command: `pnpm exec next start -p ${DEVTOOLS_PORT}`,
      url: `${DEVTOOLS_URL}/favicon.ico`,
      env: devToolsServerEnv(),
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The same build in `DEPLOYMENT_MODE=saas`: the only server where SEVERAL schools may share the database (the
      // others are Solo, where a second tenant is an invariant violation). Tenant-boundary and picker tests use it.
      command: `pnpm exec next start -p ${SAAS_PORT}`,
      url: `${SAAS_URL}/favicon.ico`,
      env: saasServerEnv(),
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The same build connected as the table OWNER instead of `app_user` — a misconfiguration that would silently turn
      // row-level security off. It must refuse to serve tenant data (tests/api/rls-assertion.spec.ts).
      command: `pnpm exec next start -p ${UNSAFE_RLS_PORT}`,
      url: `${UNSAFE_RLS_URL}/favicon.ico`,
      env: unsafeRlsServerEnv(),
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The same build, told it is served over HTTPS (=> `__Host-` + Secure cookie)…
      command: `pnpm exec next start -p ${HTTPS_APP_PORT}`,
      url: `http://localhost:${HTTPS_APP_PORT}/favicon.ico`,
      env: httpsServerEnv(),
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // …and the TLS proxy that actually serves it as HTTPS.
      command: `node tests/support/tls-proxy.mjs ${TLS_PORT} ${HTTPS_APP_PORT}`,
      url: `${HTTPS_URL}/favicon.ico`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],

  projects: [
    { name: "setup", testDir: "./tests/setup", testMatch: /.*\.setup\.ts/ },
    { name: "unit", testDir: "./tests/unit" },
    { name: "integration", testDir: "./tests/integration", dependencies: ["setup"] },
    { name: "api", testDir: "./tests/api", dependencies: ["setup"] },
    {
      name: "e2e-desktop",
      testDir: "./tests/e2e",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], baseURL: HTTP_URL },
    },
    {
      name: "e2e-mobile",
      testDir: "./tests/e2e",
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"], baseURL: HTTP_URL },
    },
    {
      name: "https",
      testDir: "./tests/https",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], baseURL: HTTPS_URL, ignoreHTTPSErrors: true },
    },
  ],
});
