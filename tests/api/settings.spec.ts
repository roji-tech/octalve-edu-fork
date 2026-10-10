import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { BillingCycle, DiscountWorkflowMode, Role, RolloverMode } from "@prisma/client";
import {
  addMembership,
  codeFor,
  createTenant,
  createUser,
  db,
  enableMfa,
  removeCreatedTenants,
  rewindMfa,
  seedInstance,
  type TestMfa,
  type TestTenant,
  type TestUser,
} from "../support/db";
import { api, cookieHeader, loginAs, sessionCookie } from "../support/http";

const SAAS = { baseUrl: SAAS_URL };

let schoolA: TestTenant;
let schoolB: TestTenant;
let adminA: TestUser;
let adminWithMfa: TestUser;
let mfaData: TestMfa;
let teacherA: TestUser;
let outsider: TestUser;

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}

async function cookieForMfaUser(user: TestUser, secret: Buffer) {
  await rewindMfa(user.id);
  const step1 = await api("/api/v1/auth/login", {
    ...SAAS,
    method: "POST",
    body: { email: user.email, password: user.password },
  });
  expect(step1.status).toBe(200);
  expect(step1.json.data.mfaRequired).toBe(true);
  const challenge = step1.json.data.challenge;

  const step2 = await api("/api/v1/auth/login/mfa", {
    ...SAAS,
    method: "POST",
    body: { challenge, code: codeFor(secret) },
  });
  expect(step2.status).toBe(200);
  const cookie = sessionCookie(step2);
  expect(cookie).toBeDefined();
  return cookieHeader(cookie!.value);
}

test.beforeAll(async () => {
  await seedInstance();
  schoolA = await createTenant({ name: "Alpha Horizon Academy" });
  schoolB = await createTenant({ name: "Beta Crescent School" });

  // Standard Admin (password step-up)
  adminA = await createUser();
  await addMembership(adminA.id, schoolA.id, Role.ADMIN);

  // Admin with MFA enabled (TOTP step-up)
  adminWithMfa = await createUser();
  await addMembership(adminWithMfa.id, schoolA.id, Role.ADMIN);
  mfaData = await enableMfa(adminWithMfa.id);

  // Non-admin teacher
  teacherA = await createUser();
  await addMembership(teacherA.id, schoolA.id, Role.TEACHING_STAFF);

  // User from outside school A
  outsider = await createUser();
  await addMembership(outsider.id, schoolB.id, Role.ADMIN);
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe("GET /api/v1/schools/[code]/settings", () => {
  test("401 when unauthenticated", async () => {
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, SAAS);
    expect(res.status).toBe(401);
  });

  test("403 for non-admin roles", async () => {
    const cookie = await cookieFor(teacherA);
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, { ...SAAS, cookie });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("FORBIDDEN");
  });

  test("404/403 cross-tenant isolation: admin of School B cannot read School A", async () => {
    const cookie = await cookieFor(outsider);
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, { ...SAAS, cookie });
    expect(res.status).toBe(403);
  });

  test("200 returns school settings, audit log, and MFA status for admin", async () => {
    const cookie = await cookieFor(adminA);
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, { ...SAAS, cookie });
    expect(res.status).toBe(200);
    expect(res.json.data.settings).toBeDefined();
    expect(res.json.data.settings.resultApprovalRequired).toBe(true);
    expect(res.json.data.settings.mfaRequiredForTeaching).toBe(true);
    expect(res.json.data.hasMfa).toBe(false);
    expect(Array.isArray(res.json.data.auditLog)).toBe(true);
  });

  test("200 returns hasMfa: true when administrator has enrolled MFA", async () => {
    const cookie = await cookieForMfaUser(adminWithMfa, mfaData.secret);
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, { ...SAAS, cookie });
    expect(res.status).toBe(200);
    expect(res.json.data.hasMfa).toBe(true);
  });
});

test.describe("PATCH /api/v1/schools/[code]/settings", () => {
  test("401 when unauthenticated", async () => {
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, {
      ...SAAS,
      method: "PATCH",
      body: {
        changes: { feeReminderEnabled: false },
        stepUp: { type: "password", value: "password" },
      },
    });
    expect(res.status).toBe(401);
  });

  test("403 for non-admin role", async () => {
    const cookie = await cookieFor(teacherA);
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, {
      ...SAAS,
      method: "PATCH",
      cookie,
      body: {
        changes: { feeReminderEnabled: false },
        stepUp: { type: "password", value: teacherA.password },
      },
    });
    expect(res.status).toBe(403);
  });

  test("400 when changes payload is empty or invalid", async () => {
    const cookie = await cookieFor(adminA);
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, {
      ...SAAS,
      method: "PATCH",
      cookie,
      body: {
        changes: {},
        stepUp: { type: "password", value: adminA.password },
      },
    });
    expect(res.status).toBe(400);
  });

  test("403 WRONG_PASSWORD when step-up password proof is incorrect (no MFA enrolled)", async () => {
    const cookie = await cookieFor(adminA);
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, {
      ...SAAS,
      method: "PATCH",
      cookie,
      body: {
        changes: { feeReminderEnabled: false },
        stepUp: { type: "password", value: "totally-wrong-password" },
      },
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("WRONG_PASSWORD");

    // Verify setting was NOT changed in DB
    const current = await db.schoolSettings.findUniqueOrThrow({ where: { tenantId: schoolA.id } });
    expect(current.feeReminderEnabled).toBe(true);
  });

  test("200 updates settings and writes SettingsChangeAudit with password step-up", async () => {
    const cookie = await cookieFor(adminA);
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, {
      ...SAAS,
      method: "PATCH",
      cookie,
      body: {
        changes: {
          feeReminderEnabled: false,
          billingCycle: BillingCycle.PER_SESSION,
          rolloverMode: RolloverMode.AUTOMATIC,
        },
        stepUp: { type: "password", value: adminA.password },
      },
    });

    expect(res.status).toBe(200);
    expect(res.json.data.settings.feeReminderEnabled).toBe(false);
    expect(res.json.data.settings.billingCycle).toBe("PER_SESSION");
    expect(res.json.data.settings.rolloverMode).toBe("AUTOMATIC");
    expect(res.json.data.deltas).toHaveLength(3);

    // Verify audit log entries in DB
    const audits = await db.settingsChangeAudit.findMany({
      where: { tenantId: schoolA.id, actorUserId: adminA.id },
      orderBy: { createdAt: "desc" },
      take: 3,
    });
    expect(audits).toHaveLength(3);
    const fields = audits.map((a) => a.field);
    expect(fields).toContain("feeReminderEnabled");
    expect(fields).toContain("billingCycle");
    expect(fields).toContain("rolloverMode");
    for (const a of audits) {
      expect(a.stepUpVerifiedAt).toBeDefined();
    }
  });

  test("403 INVALID_MFA_CODE when TOTP code is wrong or expired for user with MFA", async () => {
    const cookie = await cookieForMfaUser(adminWithMfa, mfaData.secret);
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, {
      ...SAAS,
      method: "PATCH",
      cookie,
      body: {
        changes: { multiCampusEnabled: true },
        stepUp: { type: "totp", value: "000000" },
      },
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("INVALID_MFA_CODE");
  });

  test("403 INVALID_MFA_CODE when user with MFA attempts password step-up instead of second factor", async () => {
    const cookie = await cookieForMfaUser(adminWithMfa, mfaData.secret);
    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, {
      ...SAAS,
      method: "PATCH",
      cookie,
      body: {
        changes: { multiCampusEnabled: true },
        stepUp: { type: "password", value: adminWithMfa.password },
      },
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("INVALID_MFA_CODE");
  });

  test("200 updates settings and audits security-weakening toggle with TOTP step-up", async () => {
    const cookie = await cookieForMfaUser(adminWithMfa, mfaData.secret);
    await rewindMfa(adminWithMfa.id);
    const validCode = codeFor(mfaData.secret);

    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, {
      ...SAAS,
      method: "PATCH",
      cookie,
      body: {
        changes: {
          resultApprovalRequired: false, // weakening security control
          mfaRequiredForTeaching: false, // weakening security control
          discountWorkflowMode: DiscountWorkflowMode.APPROVAL_REQUIRED,
        },
        stepUp: { type: "totp", value: validCode },
      },
    });

    expect(res.status).toBe(200);
    expect(res.json.data.settings.resultApprovalRequired).toBe(false);
    expect(res.json.data.settings.mfaRequiredForTeaching).toBe(false);
    expect(res.json.data.settings.discountWorkflowMode).toBe("APPROVAL_REQUIRED");

    // Check delta classification
    const weakenedDeltas = res.json.data.deltas.filter((d: { isWeakeningSecurity: boolean }) => d.isWeakeningSecurity);
    expect(weakenedDeltas).toHaveLength(2);

    // Verify DB audit log
    const recentAudit = await db.settingsChangeAudit.findFirstOrThrow({
      where: {
        tenantId: schoolA.id,
        actorUserId: adminWithMfa.id,
        field: "resultApprovalRequired",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(recentAudit.fromValue).toBe("true");
    expect(recentAudit.toValue).toBe("false");
  });

  test("idempotent update produces 0 deltas and 0 duplicate audit rows", async () => {
    const cookie = await cookieFor(adminA);
    const current = await db.schoolSettings.findUniqueOrThrow({ where: { tenantId: schoolA.id } });

    const auditCountBefore = await db.settingsChangeAudit.count({ where: { tenantId: schoolA.id } });

    const res = await api(`/api/v1/schools/${schoolA.code}/settings`, {
      ...SAAS,
      method: "PATCH",
      cookie,
      body: {
        changes: {
          resultApprovalRequired: current.resultApprovalRequired,
        },
        stepUp: { type: "password", value: adminA.password },
      },
    });

    expect(res.status).toBe(200);
    expect(res.json.data.deltas).toEqual([]);

    const auditCountAfter = await db.settingsChangeAudit.count({ where: { tenantId: schoolA.id } });
    expect(auditCountAfter).toBe(auditCountBefore);
  });
});
