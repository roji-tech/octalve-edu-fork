import { Decimal } from "@prisma/client/runtime/library";
import { ResultStatus, Permission } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import { gradeFor } from "@/lib/academics/scoring";
import { canTransitionResult, validateComponentScores, generateVerificationToken, calculateVerificationHash } from "./rules";
import { calculateCompetitionRanks, evaluatePromotion } from "./ranking";
import type { RecordResultsInput, TransitionStatusInput, ResultFailure } from "./http";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; failure: ResultFailure; message?: string };

/**
 * Records or updates score entries for students in a given subject and period.
 */
export async function recordStudentResults(
  tx: Tx,
  tenantId: string,
  actorUserId: string,
  input: RecordResultsInput,
): Promise<ServiceResult<{ count: number; saved: string[] }>> {
  // Validate period and subject exist
  const [period, subject] = await Promise.all([
    tx.academicPeriod.findFirst({ where: { tenantId, id: input.periodId, archivedAt: null } }),
    tx.subject.findFirst({ where: { tenantId, id: input.subjectId, archivedAt: null } }),
  ]);

  if (!period || !subject) {
    return { ok: false, failure: "NOT_FOUND", message: "Academic period or subject not found." };
  }

  // Fetch tenant default grade scale if one exists
  const defaultScale = await tx.gradeScale.findFirst({
    where: { tenantId, isDefault: true, archivedAt: null },
    include: { bands: true },
  });

  const savedIds: string[] = [];

  for (const entry of input.results) {
    let finalScore = entry.score ?? 0;
    const maxScore = entry.maxScore ?? 100;

    if (entry.components && entry.components.length > 0) {
      const compValidation = validateComponentScores(entry.components, entry.score);
      if (!compValidation.ok) {
        return { ok: false, failure: "SCHEME_VALIDATION_FAILED", message: compValidation.error };
      }
      finalScore = compValidation.totalScore;
    }

    if (finalScore < 0 || finalScore > maxScore) {
      return { ok: false, failure: "SCORE_OUT_OF_BOUNDS", message: `Score ${finalScore} exceeds max ${maxScore}.` };
    }

    // Determine letter grade and remark if scale available
    let gradeLetter: string | null = null;
    let gradeRemark: string | null = null;
    if (defaultScale && defaultScale.bands.length > 0) {
      const percentage = maxScore > 0 ? (finalScore / maxScore) * 100 : finalScore;
      const matched = gradeFor(
        defaultScale.bands.map((b) => ({ min: Number(b.minScore), max: Number(b.maxScore), letter: b.letter, remark: b.remark })),
        percentage,
      );
      if (matched) {
        gradeLetter = matched.letter;
        gradeRemark = matched.remark;
      }
    }

    // Check if result already exists
    const existing = await tx.result.findUnique({
      where: {
        tenantId_studentId_subjectId_periodId: {
          tenantId,
          studentId: entry.studentId,
          subjectId: input.subjectId,
          periodId: input.periodId,
        },
      },
    });

    if (existing && existing.status === ResultStatus.LOCKED) {
      return {
        ok: false,
        failure: "INVALID_TRANSITION",
        message: "Cannot edit LOCKED results directly. An administrator must unlock them first.",
      };
    }

    const verificationToken = existing?.verificationToken ?? generateVerificationToken();

    const upserted = await tx.result.upsert({
      where: {
        tenantId_studentId_subjectId_periodId: {
          tenantId,
          studentId: entry.studentId,
          subjectId: input.subjectId,
          periodId: input.periodId,
        },
      },
      update: {
        score: new Decimal(finalScore),
        maxScore: new Decimal(maxScore),
        componentScores: entry.components ? JSON.parse(JSON.stringify(entry.components)) : undefined,
        gradeLetter,
        gradeRemark,
        updatedAt: new Date(),
      },
      create: {
        tenantId,
        studentId: entry.studentId,
        subjectId: input.subjectId,
        periodId: input.periodId,
        score: new Decimal(finalScore),
        maxScore: new Decimal(maxScore),
        status: ResultStatus.DRAFT,
        componentScores: entry.components ? JSON.parse(JSON.stringify(entry.components)) : undefined,
        gradeLetter,
        gradeRemark,
        enteredByStaffId: actorUserId,
        verificationToken,
      },
    });

    // Record audit row if updated
    if (existing && Number(existing.score) !== finalScore) {
      await tx.resultAudit.create({
        data: {
          tenantId,
          resultId: upserted.id,
          actorUserId,
          fromStatus: existing.status,
          toStatus: existing.status,
          fromScore: existing.score,
          toScore: new Decimal(finalScore),
          reason: "Score update",
        },
      });
    }

    savedIds.push(upserted.id);
  }

  return { ok: true, data: { count: savedIds.length, saved: savedIds } };
}

/**
 * Transitions the lifecycle status of one or more results with audit tracking.
 */
export async function transitionResultStatuses(
  tx: Tx,
  tenantId: string,
  actorUserId: string,
  actorRole: string,
  permissions: readonly (Permission | string)[],
  input: TransitionStatusInput,
): Promise<ServiceResult<{ updatedCount: number; toStatus: ResultStatus }>> {
  const isAdmin = actorRole === "ADMIN";
  const hasApprovePermission = permissions.includes("CAN_APPROVE_RESULTS") || isAdmin;

  const results = await tx.result.findMany({
    where: {
      tenantId,
      id: { in: input.resultIds },
    },
    include: {
      student: true,
      subject: true,
      period: { include: { session: true } },
      tenant: true,
    },
  });

  if (results.length === 0) {
    return { ok: false, failure: "NOT_FOUND", message: "No matching results found." };
  }

  // Pre-validate transitions for all target records
  for (const res of results) {
    const check = canTransitionResult(res.status, input.toStatus, {
      isAdmin,
      hasApprovePermission,
      reason: input.reason,
    });

    if (!check.allowed) {
      return { ok: false, failure: check.code, message: check.error };
    }
  }

  const now = new Date();

  for (const res of results) {
    const updateData: {
      status: ResultStatus;
      approvedByStaffId?: string;
      publishedAt?: Date;
      lockedAt?: Date;
      verificationHash?: string;
    } = {
      status: input.toStatus,
    };

    if (input.toStatus === ResultStatus.APPROVED) {
      updateData.approvedByStaffId = actorUserId;
    } else if (input.toStatus === ResultStatus.PUBLISHED) {
      updateData.publishedAt = now;
      updateData.verificationHash = calculateVerificationHash({
        tenantCode: res.tenant.code,
        admissionNo: res.student.admissionNo,
        periodLabel: res.period.label,
        sessionLabel: res.period.session.label,
        subjectCodeOrName: res.subject.code ?? res.subject.name,
        score: Number(res.score),
        maxScore: Number(res.maxScore),
        gradeLetter: res.gradeLetter,
        issuedAt: now.toISOString(),
      });
    } else if (input.toStatus === ResultStatus.LOCKED) {
      updateData.lockedAt = now;
    }

    await tx.result.update({
      where: { tenantId_id: { tenantId, id: res.id } },
      data: updateData,
    });

    // Write append-only ResultAudit row
    await tx.resultAudit.create({
      data: {
        tenantId,
        resultId: res.id,
        actorUserId,
        fromStatus: res.status,
        toStatus: input.toStatus,
        fromScore: res.score,
        toScore: res.score,
        reason: input.reason ?? null,
      },
    });
  }

  return { ok: true, data: { updatedCount: results.length, toStatus: input.toStatus } };
}

/**
 * Queries results with optional filters.
 */
export async function queryResults(
  tx: Tx,
  tenantId: string,
  filter: {
    periodId?: string;
    subjectId?: string;
    classArmId?: string;
    status?: ResultStatus;
  },
) {
  return tx.result.findMany({
    where: {
      tenantId,
      periodId: filter.periodId,
      subjectId: filter.subjectId,
      status: filter.status,
      student: filter.classArmId ? { enrollments: { some: { classArmId: filter.classArmId, status: "ACTIVE" } } } : undefined,
    },
    include: {
      student: { select: { id: true, firstName: true, lastName: true, admissionNo: true } },
      subject: { select: { id: true, name: true, code: true } },
      period: { select: { id: true, label: true, kind: true } },
    },
    orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }],
  });
}

/**
 * Retrieves the compiled term report card for an individual student.
 * Gated by strict IDOR boundaries: students/parents can only see PUBLISHED results for their own child.
 */
export async function getStudentReportCard(
  tx: Tx,
  tenantId: string,
  studentId: string,
  periodId: string,
  viewerRole: string,
  viewerUserId: string,
) {
  // IDOR Verification
  if (viewerRole === "STUDENT") {
    const student = await tx.studentRecord.findFirst({
      where: { tenantId, id: studentId, userId: viewerUserId, archivedAt: null },
    });
    if (!student) {
      return { ok: false, failure: "FORBIDDEN_STUDENT_ACCESS" as const };
    }
  } else if (viewerRole === "PARENT") {
    const guardianLink = await tx.guardianLink.findFirst({
      where: {
        tenantId,
        studentId,
        status: "APPROVED",
        guardian: { userId: viewerUserId },
      },
    });
    if (!guardianLink) {
      return { ok: false, failure: "FORBIDDEN_STUDENT_ACCESS" as const };
    }
  }

  const isPublicViewer = viewerRole === "STUDENT" || viewerRole === "PARENT";

  const [student, period, results] = await Promise.all([
    tx.studentRecord.findFirstOrThrow({
      where: { tenantId, id: studentId },
      include: {
        campus: true,
        enrollments: {
          where: { status: "ACTIVE" },
          include: { classArm: { include: { classGroup: true } }, session: true },
        },
      },
    }),
    tx.academicPeriod.findFirstOrThrow({
      where: { tenantId, id: periodId },
      include: { session: true },
    }),
    tx.result.findMany({
      where: {
        tenantId,
        studentId,
        periodId,
        status: isPublicViewer ? ResultStatus.PUBLISHED : undefined,
      },
      include: { subject: true },
    }),
  ]);

  const activeEnrollment = student.enrollments[0];
  const classArmId = activeEnrollment?.classArmId;

  // Retrieve peer results for competition ranking if class arm is known
  let classRank: number | null = null;
  let classSize: number = 0;

  if (classArmId) {
    const peerEnrollments = await tx.studentEnrollment.findMany({
      where: { tenantId, classArmId, status: "ACTIVE" },
      select: { studentId: true },
    });
    classSize = peerEnrollments.length;

    const peerStudentIds = peerEnrollments.map((e) => e.studentId);
    const peerResults = await tx.result.findMany({
      where: {
        tenantId,
        periodId,
        studentId: { in: peerStudentIds },
        status: isPublicViewer ? ResultStatus.PUBLISHED : undefined,
      },
    });

    const peerTotals: Record<string, number> = {};
    for (const sid of peerStudentIds) peerTotals[sid] = 0;
    for (const pr of peerResults) {
      peerTotals[pr.studentId] = (peerTotals[pr.studentId] ?? 0) + Number(pr.score);
    }

    const rankingData = Object.entries(peerTotals).map(([sid, total]) => ({ id: sid, total }));
    const { ranked } = calculateCompetitionRanks(rankingData, (r) => r.total);
    const myRank = ranked.find((r) => r.item.id === studentId);
    if (myRank) {
      classRank = myRank.rank;
    }
  }

  // Calculate student subject summaries
  let totalScore = 0;
  let totalMax = 0;
  const subjectsData = results.map((r) => {
    const sc = Number(r.score);
    const mx = Number(r.maxScore);
    totalScore += sc;
    totalMax += mx;
    return {
      subjectId: r.subjectId,
      subjectName: r.subject.name,
      subjectCode: r.subject.code,
      score: sc,
      maxScore: mx,
      gradeLetter: r.gradeLetter,
      gradeRemark: r.gradeRemark,
      status: r.status,
      verificationToken: r.verificationToken,
      verificationHash: r.verificationHash,
    };
  });

  const cumulativePercentage = totalMax > 0 ? Number(((totalScore / totalMax) * 100).toFixed(2)) : 0;
  const promotion = evaluatePromotion(
    subjectsData.map((s) => ({ score: s.score, maxScore: s.maxScore, passed: s.score >= s.maxScore * 0.5 })),
  );

  return {
    ok: true as const,
    data: {
      student: {
        id: student.id,
        admissionNo: student.admissionNo,
        firstName: student.firstName,
        lastName: student.lastName,
        classGroup: activeEnrollment?.classArm.classGroup.name,
        classArm: activeEnrollment?.classArm.name,
      },
      period: {
        id: period.id,
        label: period.label,
        sessionLabel: period.session.label,
      },
      summary: {
        totalScore,
        totalMax,
        percentage: cumulativePercentage,
        classRank,
        classSize,
        promotionOutcome: promotion.outcome,
      },
      subjects: subjectsData,
    },
  };
}

/**
 * Public lookup of a published credential token (referencing VerifyCertificateForm pattern).
 * Returns non-PII verification data.
 */
export async function verifyPublicCredential(token: string) {
  if (!/^[0-9a-f]{32}$/.test(token)) {
    return null;
  }

  const { forVerification, setTenantContext } = await import("@/lib/tenant/for-tenant");
  const { trustedTenantId } = await import("@/lib/tenant/verified-tenant");

  return forVerification(token).transaction(async (tx) => {
    // 1. Locate Result row permitted by app_verification_token() policy
    const probe = await tx.result.findFirst({
      where: {
        verificationToken: token,
        status: { in: [ResultStatus.PUBLISHED, ResultStatus.LOCKED] },
      },
      select: { id: true, tenantId: true },
    });

    if (!probe) {
      return null;
    }

    // 2. Promote context to discovered tenant so relation models can be joined
    await setTenantContext(tx, trustedTenantId(probe.tenantId));

    const result = await tx.result.findFirst({
      where: { id: probe.id },
      include: {
        tenant: { select: { name: true, code: true } },
        student: { select: { admissionNo: true, firstName: true, lastName: true } },
        subject: { select: { name: true, code: true } },
        period: { select: { label: true, session: { select: { label: true } } } },
      },
    });

    if (!result) {
      return null;
    }

    // Mask student full name for public privacy protection: "Zainab Aliyu" -> "Z. Aliyu"
    const maskedName = `${result.student.firstName.charAt(0)}. ${result.student.lastName}`;

    return {
      verified: true,
      institution: result.tenant.name,
      studentAdmissionNo: result.student.admissionNo,
      studentInitials: maskedName,
      academicSession: result.period.session.label,
      academicPeriod: result.period.label,
      subject: result.subject.name,
      gradeLetter: result.gradeLetter,
      publishedAt: result.publishedAt,
      verificationHash: result.verificationHash,
    };
  });
}
