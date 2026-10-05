import "../support/env";
import { test, expect } from "@playwright/test";
import { PWNED_STUB_URL, SAAS_URL } from "../support/env";
import { Role, createUser, db, seedInstance, uniqueIp } from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";
import { createResetToken } from "@/lib/auth/password-reset";
import { verifyPassword } from "@/lib/auth/password";
import { BREACHED_MESSAGE } from "@/lib/auth/pwned-password";

// The breached-password check over real HTTP against the SaaS-mode server, which asks a local stand-in for the public
// range API (plan §0.5.3, F).

const SAAS = { baseUrl: SAAS_URL };
const BREACHED = "Tr0ub4dor&3-but-leaked";
const FRESH = "a-fresh-unseen-passphrase-3";

test.beforeAll(async () => {
  await seedInstance();
});

const requests = async () => (await (await fetch(`${PWNED_STUB_URL}/__requests`)).json()) as { prefix: string; addPadding: string | null }[];

test("reset: refused with the reason, the link survives, a fresh password then works", async () => {
  const user = await createUser();
  const token = await createResetToken(user.id);
  const refused = await api("/api/v1/auth/reset-password", { ...SAAS, body: { token, password: BREACHED } });
  expect(refused.status).toBe(400);
  expect(refused.json.error).toMatchObject({ code: "VALIDATION", message: BREACHED_MESSAGE });
  const ok = await api("/api/v1/auth/reset-password", { ...SAAS, body: { token, password: FRESH } });
  expect(ok.status).toBe(200);
  expect(await verifyPassword(FRESH, (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
});

test("change: a breached new password is refused (and costs no password-attempt budget); a fresh one works", async () => {
  const user = await createUser({ role: Role.TEACHING_STAFF });
  const cookie = cookieHeader((await loginAs(user, SAAS)).token!);
  const ip = uniqueIp();
  for (let i = 0; i < 7; i++) {
    const refused = await api("/api/v1/auth/change-password", { ...SAAS, ip, cookie, body: { currentPassword: user.password, newPassword: BREACHED } });
    expect(refused.status, `attempt ${i}`).toBe(400);
    expect(refused.json.error.message).toBe(BREACHED_MESSAGE);
  }
  expect((await api("/api/v1/auth/change-password", { ...SAAS, ip, cookie, body: { currentPassword: user.password, newPassword: FRESH } })).status).toBe(200);
});

test("only the 5-character PREFIX ever reached the service — and it asked for padding", async () => {
  await fetch(`${PWNED_STUB_URL}/__requests`, { method: "DELETE" });
  const user = await createUser();
  const token = await createResetToken(user.id);
  await api("/api/v1/auth/reset-password", { ...SAAS, body: { token, password: BREACHED } });
  const seen = await requests();
  expect(seen.length).toBeGreaterThanOrEqual(1);
  for (const request of seen) {
    expect(request.prefix).toMatch(/^[0-9A-F]{5}$/);
    expect(request.addPadding).toBe("true");
  }
});

test("a server WITHOUT the check (the plain-HTTP Solo server) accepts the same password — the switch is per deployment", async () => {
  const user = await createUser();
  const token = await createResetToken(user.id);
  expect((await api("/api/v1/auth/reset-password", { body: { token, password: BREACHED } })).status).toBe(200);
});
