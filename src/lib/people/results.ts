import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";

// What a people operation can answer (plan "Build design — Phase 1.2"). The same discipline as the academic services: a refusal is DATA, not an
// exception, and a refusal found AFTER a write must roll the transaction back (ADR 0002) — `refuseAndRollBack` / `rollingBack` below.

export type PeopleFailure =
  /// No such record in THIS school or not visible to this member: unknown, another school's, another campus's — one answer.
  | "NOT_FOUND"
  | "INVALID_CAMPUS"
  /// A field failed validation; `detail.field` names it (`firstName`, `dateOfBirth`, `admissionNo`, `phone`, `email`, `reason`, …).
  | "INVALID"
  /// A live student with the same name and date of birth exists; `detail.admissionNo` names theirs (decision P4).
  | "POSSIBLE_DUPLICATE"
  | "ADMISSION_NUMBER_TAKEN"
  | "ADMISSION_NUMBER_EXHAUSTED"
  | "ARCHIVED"
  | "NOT_ARCHIVED"
  | "WRONG_STATE"
  /// A student cannot be archived while an ACTIVE enrolment remains: withdraw first (nothing is archived silently).
  | "HAS_ACTIVE_ENROLMENT"
  // --- enrolment ---
  | "INVALID_SESSION"
  | "SESSION_CLOSED"
  | "INVALID_ARM"
  /// `detail`: `{ classArmId, armName, className }` of the enrolment that already exists for that session.
  | "ALREADY_ENROLLED"
  // --- guardians ---
  | "INVALID_GUARDIAN"
  | "ALREADY_LINKED"
  /// A guardian cannot be archived while any student is still linked to them: remove the links first (nothing is archived silently).
  | "HAS_LIVE_LINKS"
  // --- staff ---
  /// The chosen member of this school already has another staff record.
  | "ACCOUNT_TAKEN"
  /// The chosen member is not an active member of this school, or their role does not match the record's category.
  | "ACCOUNT_MISMATCH"
  /// The record already has a sign-in account (unlink it first).
  | "ALREADY_LINKED_ACCOUNT"
  | "NOT_LINKED"
  | "INVALID_SUBJECT"
  | "SUBJECT_NOT_OFFERED"
  | "ALREADY_ASSIGNED"
  /// Archiving a staff record is refused while subjects are still assigned to them: remove the assignments first.
  | "HAS_ASSIGNMENTS"
  /// Inviting needs an email address on the record.
  | "EMAIL_REQUIRED"
  | "EMAIL_TAKEN"
  // --- import / export ---
  | "TOO_LARGE"
  | "TOO_MANY_ROWS"
  | "IMPORT_ERRORS";

export type PeopleResult<T> = ({ ok: true } & T) | { ok: false; reason: PeopleFailure; detail?: Record<string, unknown> };

export const refuse = (reason: PeopleFailure, detail?: Record<string, unknown>) => ({
  ok: false as const,
  reason,
  ...(detail ? { detail } : {}),
});
export const invalid = (field: string) => refuse("INVALID", { field });

class Refusal extends Error {
  constructor(readonly result: ReturnType<typeof refuse>) {
    super(result.reason);
  }
}
/// A refusal found AFTER a write in the same transaction: returning it would COMMIT what came before, so this throws (the transaction rolls back) and
/// `rollingBack` turns the throw back into the refusal for the caller. Prefer checking BEFORE writing; use this for what only a conditional write can tell.
export const refuseAndRollBack = (reason: PeopleFailure, detail?: Record<string, unknown>): never => {
  throw new Refusal(refuse(reason, detail));
};
export async function rollingBack<T>(run: () => Promise<T>): Promise<T | ReturnType<typeof refuse>> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Refusal) return error.result;
    throw error;
  }
}

/// One audit row for a people entity, written in the caller's transaction. Personal data stays out of it: ids, admission numbers and the NAMES of
/// changed fields — never a date of birth, phone or email value.
export const auditPeople = (
  tx: Tx,
  tenantId: string,
  actorUserId: string,
  targetType: string,
  action: string,
  targetId: string,
  beforeValue?: Prisma.InputJsonValue,
  afterValue?: Prisma.InputJsonValue,
  reason?: string,
) =>
  tx.auditLog.create({
    data: {
      tenantId,
      actorUserId,
      action,
      targetType,
      targetId,
      ...(beforeValue ? { beforeValue } : {}),
      ...(afterValue ? { afterValue } : {}),
      ...(reason ? { reason } : {}),
    },
  });
