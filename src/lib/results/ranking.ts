import { toHundredths } from "@/lib/academics/scoring";

export interface RankedItem<T> {
  item: T;
  score: number;
  rank: number;
  percentile: number;
}

export interface ClassStatistics {
  count: number;
  highest: number;
  lowest: number;
  average: number;
  median: number;
}

/**
 * Computes standard competition ranking ("1224" tie handling) for an array of items.
 *
 * Example:
 * Scores: [95, 90, 90, 80]
 * Ranks:  [ 1,  2,  2,  4]
 */
export function calculateCompetitionRanks<T>(
  items: readonly T[],
  getScore: (item: T) => number,
): { ranked: RankedItem<T>[]; statistics: ClassStatistics } {
  if (items.length === 0) {
    return {
      ranked: [],
      statistics: { count: 0, highest: 0, lowest: 0, average: 0, median: 0 },
    };
  }

  // Map and sort descending by score
  const sorted = items
    .map((item) => ({ item, score: getScore(item) }))
    .sort((a, b) => {
      const aH = toHundredths(a.score) ?? 0;
      const bH = toHundredths(b.score) ?? 0;
      return bH - aH;
    });

  const ranked: RankedItem<T>[] = [];
  const totalCount = sorted.length;

  let currentRank = 1;
  let prevScoreH: number | null = null;

  for (let i = 0; i < totalCount; i++) {
    const entry = sorted[i];
    const scoreH = toHundredths(entry.score) ?? 0;

    if (prevScoreH !== null && scoreH === prevScoreH) {
      // Tie: retain same rank
    } else {
      currentRank = i + 1;
    }

    prevScoreH = scoreH;

    // Percentile: fraction of cohort scored at or below this entry
    const countAtOrBelow = sorted.filter((s) => (toHundredths(s.score) ?? 0) <= scoreH).length;
    const percentile = Math.round((countAtOrBelow / totalCount) * 100);

    ranked.push({
      item: entry.item,
      score: entry.score,
      rank: currentRank,
      percentile,
    });
  }

  // Calculate statistics
  const scores = sorted.map((s) => s.score);
  const sumH = scores.reduce((acc, s) => acc + (toHundredths(s) ?? 0), 0);
  const average = Number((sumH / totalCount / 100).toFixed(2));
  const highest = scores[0];
  const lowest = scores[scores.length - 1];

  let median = 0;
  const mid = Math.floor(totalCount / 2);
  if (totalCount % 2 === 1) {
    median = scores[mid];
  } else {
    const midSumH = (toHundredths(scores[mid - 1]) ?? 0) + (toHundredths(scores[mid]) ?? 0);
    median = Number((midSumH / 2 / 100).toFixed(2));
  }

  return {
    ranked,
    statistics: {
      count: totalCount,
      highest,
      lowest,
      average,
      median,
    },
  };
}

// --- Promotion Decision Evaluation ---

export interface SubjectPerformance {
  score: number;
  maxScore: number;
  passed: boolean;
}

export interface PromotionEvaluation {
  outcome: "PROMOTED" | "REPEATED";
  averagePercentage: number;
  passedCount: number;
  totalSubjects: number;
  meetsAverageCriteria: boolean;
  meetsSubjectCountCriteria: boolean;
}

/**
 * Evaluates whether a student meets requirements for promotion to the next class level.
 * Default criteria: >= 50% cumulative average and passed at least 50% of registered subjects.
 */
export function evaluatePromotion(
  subjects: readonly SubjectPerformance[],
  minAveragePercentage = 50,
  minPassedRatio = 0.5,
): PromotionEvaluation {
  if (subjects.length === 0) {
    return {
      outcome: "REPEATED",
      averagePercentage: 0,
      passedCount: 0,
      totalSubjects: 0,
      meetsAverageCriteria: false,
      meetsSubjectCountCriteria: false,
    };
  }

  let totalPercentageSum = 0;
  let passedCount = 0;

  for (const s of subjects) {
    const percentage = s.maxScore > 0 ? (s.score / s.maxScore) * 100 : 0;
    totalPercentageSum += percentage;
    if (s.passed) passedCount++;
  }

  const averagePercentage = Number((totalPercentageSum / subjects.length).toFixed(2));
  const meetsAverageCriteria = averagePercentage >= minAveragePercentage;
  const requiredPassed = Math.ceil(subjects.length * minPassedRatio);
  const meetsSubjectCountCriteria = passedCount >= requiredPassed;

  const outcome = meetsAverageCriteria && meetsSubjectCountCriteria ? "PROMOTED" : "REPEATED";

  return {
    outcome,
    averagePercentage,
    passedCount,
    totalSubjects: subjects.length,
    meetsAverageCriteria,
    meetsSubjectCountCriteria,
  };
}
