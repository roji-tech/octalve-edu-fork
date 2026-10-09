import crypto from "node:crypto";
import { ResultStatus } from "@prisma/client";
import { toHundredths } from "@/lib/academics/scoring";

// --- Result Lifecycle State Machine (PRD §5, domain-implementation-plan §1.4) ---

export type TransitionResult =
  | { allowed: true; reasonRequired: boolean }
  | { allowed: false; error: string; code: "INVALID_TRANSITION" | "UNAUTHORIZED" | "MISSING_REASON" };

export interface TransitionContext {
  isAdmin: boolean;
  hasApprovePermission: boolean;
  reason?: string | null;
}

/**
 * Validates whether a state transition is legal and whether the caller holds requisite permissions.
 *
 * Rules:
 * - DRAFT -> SUBMITTED: any teacher or admin can submit.
 * - SUBMITTED -> APPROVED: requires CAN_APPROVE_RESULTS or ADMIN.
 * - SUBMITTED -> DRAFT: rejection back to author; requires reason.
 * - APPROVED -> PUBLISHED: requires CAN_APPROVE_RESULTS or ADMIN.
 * - APPROVED -> SUBMITTED: pullback to review; requires reason.
 * - PUBLISHED -> LOCKED: closing term results; requires ADMIN or CAN_APPROVE_RESULTS.
 * - LOCKED -> DRAFT: emergency correction; requires ADMIN and non-null reason.
 */
export function canTransitionResult(fromStatus: ResultStatus, toStatus: ResultStatus, ctx: TransitionContext): TransitionResult {
  if (fromStatus === toStatus) {
    return { allowed: false, error: "Result is already in that status", code: "INVALID_TRANSITION" };
  }

  const hasApprovalAuthority = ctx.isAdmin || ctx.hasApprovePermission;

  switch (fromStatus) {
    case ResultStatus.DRAFT:
      if (toStatus === ResultStatus.SUBMITTED) {
        return { allowed: true, reasonRequired: false };
      }
      return { allowed: false, error: "DRAFT results must be SUBMITTED first", code: "INVALID_TRANSITION" };

    case ResultStatus.SUBMITTED:
      if (toStatus === ResultStatus.APPROVED) {
        if (!hasApprovalAuthority) {
          return { allowed: false, error: "Approving results requires CAN_APPROVE_RESULTS or ADMIN", code: "UNAUTHORIZED" };
        }
        return { allowed: true, reasonRequired: false };
      }
      if (toStatus === ResultStatus.DRAFT) {
        if (!ctx.reason || ctx.reason.trim().length === 0) {
          return { allowed: false, error: "Rejecting a result back to DRAFT requires a reason", code: "MISSING_REASON" };
        }
        return { allowed: true, reasonRequired: true };
      }
      return { allowed: false, error: "SUBMITTED results can only be APPROVED or returned to DRAFT", code: "INVALID_TRANSITION" };

    case ResultStatus.APPROVED:
      if (toStatus === ResultStatus.PUBLISHED) {
        if (!hasApprovalAuthority) {
          return { allowed: false, error: "Publishing results requires CAN_APPROVE_RESULTS or ADMIN", code: "UNAUTHORIZED" };
        }
        return { allowed: true, reasonRequired: false };
      }
      if (toStatus === ResultStatus.SUBMITTED) {
        if (!ctx.reason || ctx.reason.trim().length === 0) {
          return { allowed: false, error: "Reverting an APPROVED result requires a reason", code: "MISSING_REASON" };
        }
        return { allowed: true, reasonRequired: true };
      }
      return { allowed: false, error: "APPROVED results can only be PUBLISHED or returned to SUBMITTED", code: "INVALID_TRANSITION" };

    case ResultStatus.PUBLISHED:
      if (toStatus === ResultStatus.LOCKED) {
        if (!hasApprovalAuthority) {
          return { allowed: false, error: "Locking results requires CAN_APPROVE_RESULTS or ADMIN", code: "UNAUTHORIZED" };
        }
        return { allowed: true, reasonRequired: false };
      }
      return { allowed: false, error: "PUBLISHED results can only transition to LOCKED", code: "INVALID_TRANSITION" };

    case ResultStatus.LOCKED:
      if (toStatus === ResultStatus.DRAFT) {
        if (!ctx.isAdmin) {
          return { allowed: false, error: "Only an ADMIN may unlock LOCKED results", code: "UNAUTHORIZED" };
        }
        if (!ctx.reason || ctx.reason.trim().length === 0) {
          return { allowed: false, error: "Post-lock modification requires an audited reason", code: "MISSING_REASON" };
        }
        return { allowed: true, reasonRequired: true };
      }
      return { allowed: false, error: "LOCKED results can only be unlocked to DRAFT by an administrator", code: "INVALID_TRANSITION" };

    default:
      return { allowed: false, error: "Unknown result status", code: "INVALID_TRANSITION" };
  }
}

// --- Component Score Validation ---

export interface ComponentScoreInput {
  name: string;
  score: number;
  maxScore: number;
}

export type ScoreValidationResult = { ok: true; totalScore: number } | { ok: false; error: string; index?: number };

/**
 * Validates that all individual component scores are non-negative, don't exceed their caps,
 * and sum up accurately to the overall score.
 */
export function validateComponentScores(components: readonly ComponentScoreInput[], expectedTotal?: number): ScoreValidationResult {
  let sumHundredths = 0;

  for (const [idx, comp] of components.entries()) {
    const scoreVal = toHundredths(comp.score);
    const maxVal = toHundredths(comp.maxScore);

    if (scoreVal === null) {
      return { ok: false, error: `Component "${comp.name}" score must have at most 2 decimals`, index: idx };
    }
    if (maxVal === null || maxVal <= 0) {
      return { ok: false, error: `Component "${comp.name}" max score must be positive`, index: idx };
    }
    if (scoreVal < 0) {
      return { ok: false, error: `Component "${comp.name}" score cannot be negative`, index: idx };
    }
    if (scoreVal > maxVal) {
      return { ok: false, error: `Component "${comp.name}" score (${comp.score}) exceeds max (${comp.maxScore})`, index: idx };
    }

    sumHundredths += scoreVal;
  }

  const computedTotal = sumHundredths / 100;

  if (expectedTotal !== undefined) {
    const expectedHundredths = toHundredths(expectedTotal);
    if (expectedHundredths === null || expectedHundredths !== sumHundredths) {
      return {
        ok: false,
        error: `Component sum (${computedTotal}) does not match expected total (${expectedTotal})`,
      };
    }
  }

  return { ok: true, totalScore: computedTotal };
}

// --- Cryptographic Tamper-Evident Hash & Verification Token ---

/**
 * Generates a URL-safe random token for public credential verification (16-byte hex).
 */
export function generateVerificationToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Computes a deterministic SHA-256 hash of a result/report credential for tamper evidence.
 */
export function calculateVerificationHash(payload: {
  tenantCode: string;
  admissionNo: string;
  periodLabel: string;
  sessionLabel: string;
  subjectCodeOrName: string;
  score: number;
  maxScore: number;
  gradeLetter?: string | null;
  issuedAt: string;
}): string {
  const canonical = [
    payload.tenantCode.toLowerCase(),
    payload.admissionNo.toLowerCase(),
    payload.sessionLabel,
    payload.periodLabel,
    payload.subjectCodeOrName.toLowerCase(),
    payload.score.toFixed(2),
    payload.maxScore.toFixed(2),
    payload.gradeLetter ?? "",
    payload.issuedAt,
  ].join("|");

  return crypto.createHash("sha256").update(canonical).digest("hex");
}
