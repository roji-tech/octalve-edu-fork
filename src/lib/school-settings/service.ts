import { prisma } from "@/lib/db";
import { forTenant } from "@/lib/tenant/for-tenant";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";
import { hasActiveMfa, spendRecoveryCode, verifyTotpForUser } from "@/lib/auth/mfa/service";
import { proveOwnPassword } from "@/lib/auth/reauth";
import { getSchoolSettings } from "./read";
import { computeSettingsDeltas, type SettingsDelta, type UpdatableSettings } from "./rules";
import type { StepUpProofInput } from "./http";
import type { SchoolSettings, SettingsChangeAudit } from "@prisma/client";

export interface AuditEntryWithActor extends SettingsChangeAudit {
  actorName: string;
  actorEmail: string;
}

export interface SchoolSettingsDetail {
  settings: SchoolSettings;
  auditLog: AuditEntryWithActor[];
  hasMfa: boolean;
}

export type StepUpVerificationResult =
  | { ok: true; verifiedAt: Date }
  | { ok: false; reason: "INVALID_MFA_CODE" | "WRONG_PASSWORD" | "RATE_LIMITED" | "MFA_NOT_ENROLLED"; status: number };

/// Verifies step-up re-authentication (PRD §14, plan §1.3).
/// If MFA is active, verifies TOTP or recovery code.
/// If MFA is not yet enrolled, verifies own password with rate limiting.
export async function verifyStepUpProof(userId: string, stepUp: StepUpProofInput): Promise<StepUpVerificationResult> {
  const mfaActive = await hasActiveMfa(userId);

  if (mfaActive) {
    if (stepUp.type === "totp") {
      const valid = await verifyTotpForUser(userId, stepUp.value);
      if (!valid) return { ok: false, reason: "INVALID_MFA_CODE", status: 403 };
      return { ok: true, verifiedAt: new Date() };
    }

    if (stepUp.type === "recovery") {
      const valid = await spendRecoveryCode(userId, stepUp.value);
      if (!valid) return { ok: false, reason: "INVALID_MFA_CODE", status: 403 };
      return { ok: true, verifiedAt: new Date() };
    }

    // Attempting password when MFA is configured:
    return { ok: false, reason: "INVALID_MFA_CODE", status: 403 };
  }

  // Fallback when MFA is not enrolled: re-authenticate via password
  if (stepUp.type === "password") {
    const proof = await proveOwnPassword(userId, stepUp.value);
    if (proof === "limited") {
      return { ok: false, reason: "RATE_LIMITED", status: 429 };
    }
    if (proof === "wrong") {
      return { ok: false, reason: "WRONG_PASSWORD", status: 403 };
    }
    return { ok: true, verifiedAt: new Date() };
  }

  return { ok: false, reason: "MFA_NOT_ENROLLED", status: 400 };
}

/// Reads current school settings and recent audit log.
export async function getSchoolSettingsDetail(tenantId: string, currentUserId: string): Promise<SchoolSettingsDetail> {
  const trusted = trustedTenantId(tenantId);

  const { settings, rawAudits } = await forTenant(trusted).transaction(async (tx) => {
    const settings = await getSchoolSettings(tx, trusted);
    const rawAudits = await tx.settingsChangeAudit.findMany({
      where: { tenantId: trusted },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return { settings, rawAudits };
  });

  // Enrich audits with actor user names and emails
  const actorIds = Array.from(new Set(rawAudits.map((a) => a.actorUserId)));
  const users = await prisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, name: true, email: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const auditLog: AuditEntryWithActor[] = rawAudits.map((a) => {
    const actor = userMap.get(a.actorUserId);
    return {
      ...a,
      actorName: actor?.name ?? "Administrator",
      actorEmail: actor?.email ?? a.actorUserId,
    };
  });

  const hasMfa = await hasActiveMfa(currentUserId);

  return {
    settings,
    auditLog,
    hasMfa,
  };
}

/// Atomically creates audit log entries with stepUpVerifiedAt and applies the settings changes.
export async function mutateSchoolSettings(
  tenantId: string,
  actorUserId: string,
  changes: UpdatableSettings,
  stepUpVerifiedAt: Date,
): Promise<{ settings: SchoolSettings; deltas: SettingsDelta[] }> {
  const trusted = trustedTenantId(tenantId);

  return forTenant(trusted).transaction(async (tx) => {
    const current = await getSchoolSettings(tx, trusted);
    const deltas = computeSettingsDeltas(current, changes);

    if (deltas.length === 0) {
      return { settings: current, deltas: [] };
    }

    // Write immutable audit log entries before applying changes
    for (const delta of deltas) {
      await tx.settingsChangeAudit.create({
        data: {
          tenantId: trusted,
          actorUserId,
          field: delta.field,
          fromValue: delta.fromValue,
          toValue: delta.toValue,
          stepUpVerifiedAt,
        },
      });
    }

    const updated = await tx.schoolSettings.update({
      where: { tenantId: trusted },
      data: changes,
    });

    return { settings: updated, deltas };
  });
}
