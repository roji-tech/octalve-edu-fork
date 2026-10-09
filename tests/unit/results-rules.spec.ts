import { test, expect } from "@playwright/test";
import { ResultStatus } from "@prisma/client";
import { canTransitionResult, validateComponentScores, calculateVerificationHash, generateVerificationToken } from "@/lib/results/rules";
import { calculateCompetitionRanks, evaluatePromotion } from "@/lib/results/ranking";

test.describe("Phase 1.4: Results Pure Rules & State Machine", () => {
  test("State Machine: normal lifecycle DRAFT -> SUBMITTED -> APPROVED -> PUBLISHED -> LOCKED", () => {
    const teacherCtx = { isAdmin: false, hasApprovePermission: false };
    const approverCtx = { isAdmin: false, hasApprovePermission: true };
    const adminCtx = { isAdmin: true, hasApprovePermission: false };

    // Teacher can submit draft
    const step1 = canTransitionResult(ResultStatus.DRAFT, ResultStatus.SUBMITTED, teacherCtx);
    expect(step1.allowed).toBe(true);
    if (step1.allowed) {
      expect(step1.reasonRequired).toBe(false);
    }

    // Teacher CANNOT directly approve
    const step2Teacher = canTransitionResult(ResultStatus.SUBMITTED, ResultStatus.APPROVED, teacherCtx);
    expect(step2Teacher.allowed).toBe(false);
    if (!step2Teacher.allowed) {
      expect(step2Teacher.code).toBe("UNAUTHORIZED");
    }

    // Approver can approve submitted results
    const step2Approver = canTransitionResult(ResultStatus.SUBMITTED, ResultStatus.APPROVED, approverCtx);
    expect(step2Approver.allowed).toBe(true);

    // Admin can also approve
    const step2Admin = canTransitionResult(ResultStatus.SUBMITTED, ResultStatus.APPROVED, adminCtx);
    expect(step2Admin.allowed).toBe(true);

    // Approver can publish approved results
    const step3 = canTransitionResult(ResultStatus.APPROVED, ResultStatus.PUBLISHED, approverCtx);
    expect(step3.allowed).toBe(true);

    // Locking published results
    const step4 = canTransitionResult(ResultStatus.PUBLISHED, ResultStatus.LOCKED, approverCtx);
    expect(step4.allowed).toBe(true);
  });

  test("State Machine: rejection and reversals require explicit reason", () => {
    const approverWithoutReason = { isAdmin: false, hasApprovePermission: true, reason: "" };
    const approverWithReason = { isAdmin: false, hasApprovePermission: true, reason: "Math exam score recount requested" };

    // SUBMITTED -> DRAFT without reason is refused
    const rejWithout = canTransitionResult(ResultStatus.SUBMITTED, ResultStatus.DRAFT, approverWithoutReason);
    expect(rejWithout.allowed).toBe(false);
    if (!rejWithout.allowed) {
      expect(rejWithout.code).toBe("MISSING_REASON");
    }

    // SUBMITTED -> DRAFT with reason is allowed
    const rejWith = canTransitionResult(ResultStatus.SUBMITTED, ResultStatus.DRAFT, approverWithReason);
    expect(rejWith.allowed).toBe(true);
    if (rejWith.allowed) {
      expect(rejWith.reasonRequired).toBe(true);
    }

    // APPROVED -> SUBMITTED requires reason
    const revWithout = canTransitionResult(ResultStatus.APPROVED, ResultStatus.SUBMITTED, approverWithoutReason);
    expect(revWithout.allowed).toBe(false);
    if (!revWithout.allowed) {
      expect(revWithout.code).toBe("MISSING_REASON");
    }

    const revWith = canTransitionResult(ResultStatus.APPROVED, ResultStatus.SUBMITTED, approverWithReason);
    expect(revWith.allowed).toBe(true);
  });

  test("State Machine: emergency post-lock modification requires ADMIN and audited reason", () => {
    const nonAdmin = { isAdmin: false, hasApprovePermission: true, reason: "Correction" };
    const adminNoReason = { isAdmin: true, hasApprovePermission: false, reason: "" };
    const adminWithReason = { isAdmin: true, hasApprovePermission: false, reason: "Board examination committee rectifying typing error" };

    const nonAdminRes = canTransitionResult(ResultStatus.LOCKED, ResultStatus.DRAFT, nonAdmin);
    expect(nonAdminRes.allowed).toBe(false);
    if (!nonAdminRes.allowed) {
      expect(nonAdminRes.code).toBe("UNAUTHORIZED");
    }

    const adminNoReasonRes = canTransitionResult(ResultStatus.LOCKED, ResultStatus.DRAFT, adminNoReason);
    expect(adminNoReasonRes.allowed).toBe(false);
    if (!adminNoReasonRes.allowed) {
      expect(adminNoReasonRes.code).toBe("MISSING_REASON");
    }

    const unlock = canTransitionResult(ResultStatus.LOCKED, ResultStatus.DRAFT, adminWithReason);
    expect(unlock.allowed).toBe(true);
    if (unlock.allowed) {
      expect(unlock.reasonRequired).toBe(true);
    }
  });

  test("Component Score Validation: checks caps, precision, and sum matches", () => {
    const validComponents = [
      { name: "Continuous Assessment 1", score: 15, maxScore: 20 },
      { name: "Continuous Assessment 2", score: 18.5, maxScore: 20 },
      { name: "Final Examination", score: 55, maxScore: 60 },
    ];

    const result = validateComponentScores(validComponents, 88.5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totalScore).toBe(88.5);
    }

    // Exceeding max score
    const exceeding = [{ name: "CA 1", score: 25, maxScore: 20 }];
    expect(validateComponentScores(exceeding).ok).toBe(false);

    // Negative score
    const negative = [{ name: "CA 1", score: -5, maxScore: 20 }];
    expect(validateComponentScores(negative).ok).toBe(false);

    // Mismatched expected total
    expect(validateComponentScores(validComponents, 90).ok).toBe(false);
  });

  test("Cryptographic Tamper-Evident Hash: deterministic and sensitive to changes", () => {
    const token = generateVerificationToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    const basePayload = {
      tenantCode: "demo-school",
      admissionNo: "2026/0042",
      periodLabel: "First Term",
      sessionLabel: "2026/2027",
      subjectCodeOrName: "MATHEMATICS",
      score: 87.5,
      maxScore: 100,
      gradeLetter: "A",
      issuedAt: "2026-10-15T10:00:00Z",
    };

    const hash1 = calculateVerificationHash(basePayload);
    const hash2 = calculateVerificationHash(basePayload);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);

    // Any change produces a completely different hash
    const tamperedScoreHash = calculateVerificationHash({ ...basePayload, score: 87.6 });
    expect(tamperedScoreHash).not.toBe(hash1);

    const tamperedStudentHash = calculateVerificationHash({ ...basePayload, admissionNo: "2026/0043" });
    expect(tamperedStudentHash).not.toBe(hash1);
  });
});

test.describe("Phase 1.4: Competition Ranking & Promotion", () => {
  test("Standard competition ranking assigns correct ties (1224 ranking)", () => {
    const students = [
      { id: "S1", name: "Alice", totalScore: 95 },
      { id: "S2", name: "Bob", totalScore: 88 },
      { id: "S3", name: "Charlie", totalScore: 88 }, // Tied 2nd
      { id: "S4", name: "David", totalScore: 82 }, // 4th
      { id: "S5", name: "Emma", totalScore: 75 }, // 5th
    ];

    const { ranked, statistics } = calculateCompetitionRanks(students, (s) => s.totalScore);

    expect(ranked[0].item.id).toBe("S1");
    expect(ranked[0].rank).toBe(1);

    expect(ranked[1].item.id).toBe("S2");
    expect(ranked[1].rank).toBe(2);

    expect(ranked[2].item.id).toBe("S3");
    expect(ranked[2].rank).toBe(2);

    expect(ranked[3].item.id).toBe("S4");
    expect(ranked[3].rank).toBe(4);

    expect(ranked[4].item.id).toBe("S5");
    expect(ranked[4].rank).toBe(5);

    expect(statistics.count).toBe(5);
    expect(statistics.highest).toBe(95);
    expect(statistics.lowest).toBe(75);
    expect(statistics.average).toBe(85.6);
    expect(statistics.median).toBe(88);
  });

  test("Promotion decision logic adheres to average and passing subject thresholds", () => {
    const strongPerformance = [
      { score: 75, maxScore: 100, passed: true },
      { score: 68, maxScore: 100, passed: true },
      { score: 82, maxScore: 100, passed: true },
      { score: 55, maxScore: 100, passed: true },
      { score: 45, maxScore: 100, passed: false },
    ];

    const evalStrong = evaluatePromotion(strongPerformance, 50, 0.5);
    expect(evalStrong.outcome).toBe("PROMOTED");
    expect(evalStrong.passedCount).toBe(4);
    expect(evalStrong.averagePercentage).toBe(65);

    const weakPerformance = [
      { score: 42, maxScore: 100, passed: false },
      { score: 38, maxScore: 100, passed: false },
      { score: 45, maxScore: 100, passed: false },
      { score: 52, maxScore: 100, passed: true },
      { score: 30, maxScore: 100, passed: false },
    ];

    const evalWeak = evaluatePromotion(weakPerformance, 50, 0.5);
    expect(evalWeak.outcome).toBe("REPEATED");
    expect(evalWeak.meetsAverageCriteria).toBe(false);
  });
});
