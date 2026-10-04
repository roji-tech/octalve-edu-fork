import "../support/env";
import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Role, createUser, db, enableMfa, uniqueEmail } from "../support/db";
import { createChallenge } from "@/lib/auth/mfa/challenge";
import { createSession } from "@/lib/auth/session";

// `pnpm mfa:reset -- <email>`: the operator's way back in for someone who lost both their authenticator and
// their recovery codes. Run here as the real script, as a child process, against the test database.

const run = promisify(execFile);
const script = (...args: string[]) =>
  run(process.execPath, ["scripts/mfa-reset.mjs", ...args], { env: process.env, cwd: process.cwd() }).then(
    (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }),
  );

test.describe("scripts/mfa-reset.mjs", () => {
  test("removes the second factor, signs the person out everywhere, audits it — and touches nobody else", async () => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    const bystander = await createUser();
    await enableMfa(user.id);
    await enableMfa(bystander.id);
    await createChallenge(user.id, false);
    await createSession(user.id);
    await createSession(user.id);
    await createSession(bystander.id);

    const res = await script(user.email);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain(user.email);
    expect(res.out).toMatch(/removed/i);

    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.mfaChallenge.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    const audit = await db.auditLog.findMany({ where: { actorUserId: user.id, action: "MFA_RESET" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].reason).toMatch(/operator/i);

    expect(await db.mfaCredential.count({ where: { userId: bystander.id } })).toBe(1);
    expect(await db.mfaRecoveryCode.count({ where: { userId: bystander.id } })).toBe(10);
    expect(await db.session.count({ where: { userId: bystander.id } })).toBe(1);
  });

  test("the address is case-insensitive, and pnpm's leading `--` is ignored", async () => {
    const user = await createUser({ email: uniqueEmail("reset"), role: Role.TEACHING_STAFF });
    await enableMfa(user.id);
    const res = await script("--", user.email.toUpperCase());
    expect(res.code, res.err).toBe(0);
    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(0);
  });

  test("someone without two-step verification: says so, still signs them out, writes no audit row", async () => {
    const user = await createUser({ role: Role.TEACHING_STAFF });
    await createSession(user.id);
    const res = await script(user.email);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/did not have two-step verification/);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { actorUserId: user.id, action: "MFA_RESET" } })).toBe(0);
  });

  test("an unknown address exits 1; wrong usage exits 2 — and neither changes anything", async () => {
    const user = await createUser();
    await enableMfa(user.id);
    expect((await script(uniqueEmail("nobody"))).code).toBe(1);
    expect((await script()).code).toBe(2);
    expect((await script("a@b.c", "d@e.f")).code).toBe(2);
    expect((await script("--help")).code).toBe(2);
    expect(await db.mfaCredential.count({ where: { userId: user.id } })).toBe(1);
  });

  test("after it, the person signs in with their password alone and can set two-step verification up again", async () => {
    const user = await createUser();
    await enableMfa(user.id);
    expect((await script(user.email)).code).toBe(0);
    const { hasActiveMfa } = await import("@/lib/auth/mfa/service");
    expect(await hasActiveMfa(user.id)).toBe(false);
    const { beginEnrolment } = await import("@/lib/auth/mfa/service");
    expect(await beginEnrolment(user.id, { issuer: "x", account: "y" })).not.toBeNull();
  });
});
