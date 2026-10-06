import crypto from "node:crypto";

// The pure rules of assessment schemes and grade scales (plan "Build design — Phase 1.0 and 1.1", decisions 14 and 15). No database, no clock.
// Scores are DECIMALS with at most two places; every comparison is done on integers of HUNDREDTHS so 0.1 + 0.2 is exactly 0.3 and a total can
// never be "off by a rounding error".

/// A score or maximum as an integer count of hundredths, or null when it is not a finite number with at most two decimal places.
export function toHundredths(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Judged by the number's OWN shortest decimal form, not by a tolerance: 0.1 + 0.2 is 0.30000000000000004 and is refused, 0.29 is 0.29.
  const text = String(value);
  if (/e/i.test(text)) return null; // exponent form (huge or tiny): never a score
  const dot = text.indexOf(".");
  if (dot !== -1 && text.length - dot - 1 > 2) return null;
  return Math.round(value * 100);
}
const fixed = (hundredths: number) => (hundredths / 100).toFixed(2);

// --- assessment schemes ---------------------------------------------------------------------------------------------------------

export const MAX_COMPONENTS = 10;
export const COMPONENT_NAME_MAX = 40;

export type ComponentInput = { name: string; maxScore: number };
export type SchemeInput = { totalMax: number; examMax: number; components: readonly ComponentInput[] };
export type SchemeProblem =
  | "PRECISION"
  | "TOTAL_NOT_POSITIVE"
  | "EXAM_NEGATIVE"
  | "NO_COMPONENTS"
  | "TOO_MANY_COMPONENTS"
  | "COMPONENT_NAME_INVALID"
  | "COMPONENT_NAME_DUPLICATE"
  | "COMPONENT_MAX_NOT_POSITIVE"
  | "SUM_MISMATCH";

/// A scheme is valid when every maximum is positive (the exam's may be zero), names are 1–40 characters and unique ignoring case, there are 1–10
/// components, and **components + exam = total, exactly**. Returns the first problem (with the component's index where it has one), or null.
export function checkScheme(input: SchemeInput): { problem: SchemeProblem; index?: number; sum?: number } | null {
  const total = toHundredths(input.totalMax);
  const exam = toHundredths(input.examMax);
  if (total === null || exam === null) return { problem: "PRECISION" };
  if (total <= 0) return { problem: "TOTAL_NOT_POSITIVE" };
  if (exam < 0) return { problem: "EXAM_NEGATIVE" };
  if (input.components.length === 0) return { problem: "NO_COMPONENTS" };
  if (input.components.length > MAX_COMPONENTS) return { problem: "TOO_MANY_COMPONENTS" };
  const seen = new Set<string>();
  let sum = exam;
  for (const [index, component] of input.components.entries()) {
    const name = typeof component.name === "string" ? component.name.replace(/\s+/g, " ").trim() : "";
    if (name.length < 1 || name.length > COMPONENT_NAME_MAX) return { problem: "COMPONENT_NAME_INVALID", index };
    if (seen.has(name.toLowerCase())) return { problem: "COMPONENT_NAME_DUPLICATE", index };
    seen.add(name.toLowerCase());
    const max = toHundredths(component.maxScore);
    if (max === null) return { problem: "PRECISION", index };
    if (max <= 0) return { problem: "COMPONENT_MAX_NOT_POSITIVE", index };
    sum += max;
  }
  return sum === total ? null : { problem: "SUM_MISMATCH", sum: sum / 100 };
}

export type SchemeSnapshot = { json: string; sha256: string };

/// The canonical, order-independent form of a scheme that a result will store (plan decision 14): totals and maximums as fixed two-decimal strings,
/// components in their `sortOrder` (then name), the keys in a fixed order — so the same scheme always gives the same bytes and the same hash, and a
/// later reader can prove a stored snapshot still matches. (The database row's ids and timestamps are NOT part of it.)
export function snapshotScheme(scheme: {
  totalMax: number;
  examMax: number;
  components: readonly { name: string; maxScore: number; sortOrder: number }[];
}): SchemeSnapshot {
  const components = [...scheme.components]
    .sort((x, y) => x.sortOrder - y.sortOrder || x.name.localeCompare(y.name))
    .map((component) => ({ name: component.name, maxScore: fixed(toHundredths(component.maxScore) ?? NaN) }));
  const json = JSON.stringify({
    totalMax: fixed(toHundredths(scheme.totalMax) ?? NaN),
    examMax: fixed(toHundredths(scheme.examMax) ?? NaN),
    components,
  });
  return { json, sha256: crypto.createHash("sha256").update(json).digest("hex") };
}

// --- grade scales ---------------------------------------------------------------------------------------------------------------

export const MAX_BANDS = 12;
export const LETTER_MAX = 4;
export const REMARK_MAX = 40;

export type BandInput = { min: number; max: number; letter: string; remark: string };
export type ScaleProblem =
  | "PRECISION"
  | "NO_BANDS"
  | "TOO_MANY_BANDS"
  | "OUT_OF_RANGE"
  | "NOT_ASCENDING"
  | "GAP"
  | "OVERLAP"
  | "STARTS_ABOVE_ZERO"
  | "ENDS_BELOW_HUNDRED"
  | "LETTER_INVALID"
  | "LETTER_DUPLICATE"
  | "REMARK_INVALID";

/// Bands are HALF-OPEN and contiguous: `[min, max)`, except the top band, which is closed at 100. A valid scale starts at 0, ends at 100, and each
/// band's `min` equals the previous band's `max` — so no score, whole or decimal, falls in a gap or in two bands. Letters are 1–4 characters and
/// unique ignoring case; remarks are 1–40. Bands are given in any order; the first problem found (with the band's index) is returned, or null.
export function checkBands(bands: readonly BandInput[]): { problem: ScaleProblem; index?: number } | null {
  if (bands.length === 0) return { problem: "NO_BANDS" };
  if (bands.length > MAX_BANDS) return { problem: "TOO_MANY_BANDS" };
  const letters = new Set<string>();
  const parsed: { min: number; max: number; index: number }[] = [];
  for (const [index, band] of bands.entries()) {
    const min = toHundredths(band.min);
    const max = toHundredths(band.max);
    if (min === null || max === null) return { problem: "PRECISION", index };
    if (min < 0 || max > 10000) return { problem: "OUT_OF_RANGE", index };
    if (min >= max) return { problem: "NOT_ASCENDING", index };
    const letter = typeof band.letter === "string" ? band.letter.trim() : "";
    if (letter.length < 1 || letter.length > LETTER_MAX) return { problem: "LETTER_INVALID", index };
    if (letters.has(letter.toLowerCase())) return { problem: "LETTER_DUPLICATE", index };
    letters.add(letter.toLowerCase());
    const remark = typeof band.remark === "string" ? band.remark.trim() : "";
    if (remark.length < 1 || remark.length > REMARK_MAX) return { problem: "REMARK_INVALID", index };
    parsed.push({ min, max, index });
  }
  parsed.sort((x, y) => x.min - y.min || x.max - y.max);
  if (parsed[0].min > 0) return { problem: "STARTS_ABOVE_ZERO", index: parsed[0].index };
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].min < parsed[i - 1].max) return { problem: "OVERLAP", index: parsed[i].index };
    if (parsed[i].min > parsed[i - 1].max) return { problem: "GAP", index: parsed[i].index };
  }
  if (parsed[parsed.length - 1].max < 10000) return { problem: "ENDS_BELOW_HUNDRED", index: parsed[parsed.length - 1].index };
  return null;
}

/// The band a score belongs to — the only way a score becomes a letter. `[min, max)`, with 100 itself in the top band. A score outside 0–100 (or not
/// a finite number with at most two decimals) belongs to none → null. Assumes `bands` already passed `checkBands`.
export function gradeFor<T extends { min: number; max: number }>(bands: readonly T[], score: number): T | null {
  const value = toHundredths(score);
  if (value === null || value < 0 || value > 10000) return null;
  for (const band of bands) {
    const min = toHundredths(band.min)!;
    const max = toHundredths(band.max)!;
    if (value >= min && (value < max || (value === 10000 && max === 10000))) return band;
  }
  return null;
}
