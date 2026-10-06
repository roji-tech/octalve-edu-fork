import "../support/env";
import { test, expect } from "@playwright/test";
import { checkBands, checkScheme, gradeFor, snapshotScheme, toHundredths, type BandInput } from "@/lib/academics/scoring";

// The pure rules of assessment schemes and grade scales (plan "Build design — Phase 1.0 and 1.1", decisions 14 and 15). Every boundary is spelled out.

test.describe("toHundredths", () => {
  test("a number with at most two decimals becomes an exact integer of hundredths; anything else is null", () => {
    expect(toHundredths(10)).toBe(1000);
    expect(toHundredths(0.1)).toBe(10);
    expect(toHundredths(0.29)).toBe(29);
    expect(toHundredths(12.34)).toBe(1234);
    expect(toHundredths(0.1 + 0.2)).toBeNull(); // 0.30000000000000004 is NOT a two-decimal number
    expect(toHundredths(1.005)).toBeNull();
    expect(toHundredths(NaN)).toBeNull();
    expect(toHundredths(Infinity)).toBeNull();
    expect(toHundredths("10" as never)).toBeNull();
    expect(toHundredths(null as never)).toBeNull();
    expect(toHundredths(-5)).toBe(-500);
  });
});

test.describe("checkScheme — components + exam = total, exactly", () => {
  const c = (name: string, maxScore: number) => ({ name, maxScore });
  test("the usual shapes are valid: 10 + 10 + 20 + 60 = 100; exam-less 40 + 60 as two components; a different total; an exam of zero", () => {
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("CA1", 10), c("CA2", 10), c("Test", 20)] })).toBeNull();
    expect(checkScheme({ totalMax: 100, examMax: 0, components: [c("Coursework", 40), c("Project", 60)] })).toBeNull();
    expect(checkScheme({ totalMax: 50, examMax: 30, components: [c("CA", 20)] })).toBeNull();
    expect(checkScheme({ totalMax: 100, examMax: 70, components: [c("CA", 30)] })).toBeNull();
  });
  test("the sum must match to the hundredth — one hundredth over or under is refused, and decimals add exactly (no float drift)", () => {
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("CA1", 10), c("CA2", 10), c("Test", 20.01)] })).toMatchObject({
      problem: "SUM_MISMATCH",
      sum: 100.01,
    });
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("CA1", 10), c("CA2", 10), c("Test", 19.99)] })).toMatchObject({
      problem: "SUM_MISMATCH",
      sum: 99.99,
    });
    expect(checkScheme({ totalMax: 1, examMax: 0.7, components: [c("A", 0.1), c("B", 0.2)] })).toBeNull(); // 0.7 + 0.1 + 0.2, exactly 1
    expect(checkScheme({ totalMax: 0.3, examMax: 0.1, components: [c("A", 0.2)] })).toBeNull();
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("CA1", 40)] })).toBeNull();
  });
  test("every other rule has its own refusal: precision, a non-positive total, a negative exam, no components, too many, bad or repeated names, a non-positive maximum", () => {
    expect(checkScheme({ totalMax: 100.005, examMax: 60, components: [c("A", 40)] })).toMatchObject({ problem: "PRECISION" });
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("A", 39.999)] })).toMatchObject({ problem: "PRECISION", index: 0 });
    expect(checkScheme({ totalMax: 0, examMax: 0, components: [c("A", 0)] })).toMatchObject({ problem: "TOTAL_NOT_POSITIVE" });
    expect(checkScheme({ totalMax: -100, examMax: 0, components: [c("A", 1)] })).toMatchObject({ problem: "TOTAL_NOT_POSITIVE" });
    expect(checkScheme({ totalMax: 100, examMax: -1, components: [c("A", 101)] })).toMatchObject({ problem: "EXAM_NEGATIVE" });
    expect(checkScheme({ totalMax: 100, examMax: 100, components: [] })).toMatchObject({ problem: "NO_COMPONENTS" });
    const eleven = Array.from({ length: 11 }, (_, i) => c(`C${i}`, 1));
    expect(checkScheme({ totalMax: 100, examMax: 89, components: eleven })).toMatchObject({ problem: "TOO_MANY_COMPONENTS" });
    const ten = Array.from({ length: 10 }, (_, i) => c(`C${i}`, 1));
    expect(checkScheme({ totalMax: 100, examMax: 90, components: ten })).toBeNull(); // ten is allowed
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("", 40)] })).toMatchObject({
      problem: "COMPONENT_NAME_INVALID",
      index: 0,
    });
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("   ", 40)] })).toMatchObject({ problem: "COMPONENT_NAME_INVALID" });
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("x".repeat(41), 40)] })).toMatchObject({
      problem: "COMPONENT_NAME_INVALID",
    });
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("x".repeat(40), 40)] })).toBeNull();
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("CA", 20), c("ca", 20)] })).toMatchObject({
      problem: "COMPONENT_NAME_DUPLICATE",
      index: 1,
    });
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("CA", 20), c(" CA  ", 20)] })).toMatchObject({
      problem: "COMPONENT_NAME_DUPLICATE",
    });
    expect(checkScheme({ totalMax: 100, examMax: 60, components: [c("A", 0), c("B", 40)] })).toMatchObject({
      problem: "COMPONENT_MAX_NOT_POSITIVE",
      index: 0,
    });
    expect(checkScheme({ totalMax: 100, examMax: 100, components: [c("A", -5), c("B", 5)] })).toMatchObject({
      problem: "COMPONENT_MAX_NOT_POSITIVE",
      index: 0,
    });
  });
});

test.describe("snapshotScheme — what a result will store", () => {
  const scheme = {
    totalMax: 100,
    examMax: 60,
    components: [
      { name: "CA2", maxScore: 10, sortOrder: 2 },
      { name: "CA1", maxScore: 10, sortOrder: 1 },
      { name: "Test", maxScore: 20, sortOrder: 3 },
    ],
  };
  test("canonical JSON: fixed two-decimal strings, components in sortOrder, keys in a fixed order", () => {
    expect(snapshotScheme(scheme).json).toBe(
      '{"totalMax":"100.00","examMax":"60.00","components":[{"name":"CA1","maxScore":"10.00"},{"name":"CA2","maxScore":"10.00"},{"name":"Test","maxScore":"20.00"}]}',
    );
  });
  test("the hash does not depend on the order the components were given in, nor on how a number was written — and changes with ANY real difference", () => {
    const shuffled = { ...scheme, components: [scheme.components[2], scheme.components[0], scheme.components[1]] };
    expect(snapshotScheme(shuffled)).toEqual(snapshotScheme(scheme));
    expect(snapshotScheme({ ...scheme, totalMax: 100.0, examMax: 60.0 }).sha256).toBe(snapshotScheme(scheme).sha256);
    expect(snapshotScheme(scheme).sha256).toMatch(/^[0-9a-f]{64}$/);
    const base = snapshotScheme(scheme).sha256;
    expect(snapshotScheme({ ...scheme, examMax: 60.01 }).sha256).not.toBe(base);
    expect(
      snapshotScheme({ ...scheme, components: scheme.components.map((x) => (x.name === "Test" ? { ...x, maxScore: 19.99 } : x)) }).sha256,
    ).not.toBe(base);
    expect(
      snapshotScheme({ ...scheme, components: scheme.components.map((x) => (x.name === "Test" ? { ...x, name: "Quiz" } : x)) }).sha256,
    ).not.toBe(base);
    expect(
      snapshotScheme({ ...scheme, components: scheme.components.map((x) => (x.name === "CA1" ? { ...x, sortOrder: 9 } : x)) }).sha256,
    ).not.toBe(base); // a different ORDER is a different scheme
    expect(snapshotScheme({ ...scheme, components: scheme.components.slice(1) }).sha256).not.toBe(base);
  });
  test("equal sortOrder ties break by name, so the snapshot is still deterministic", () => {
    const tied = {
      totalMax: 20,
      examMax: 0,
      components: [
        { name: "B", maxScore: 10, sortOrder: 1 },
        { name: "A", maxScore: 10, sortOrder: 1 },
      ],
    };
    expect(snapshotScheme(tied).json).toContain('"name":"A"');
    expect(snapshotScheme(tied).json.indexOf('"name":"A"')).toBeLessThan(snapshotScheme(tied).json.indexOf('"name":"B"'));
  });
});

test.describe("checkBands — contiguous, half-open, 0 to 100", () => {
  const WAEC: BandInput[] = [
    { min: 75, max: 100, letter: "A1", remark: "Excellent" },
    { min: 70, max: 75, letter: "B2", remark: "Very good" },
    { min: 65, max: 70, letter: "B3", remark: "Good" },
    { min: 60, max: 65, letter: "C4", remark: "Credit" },
    { min: 55, max: 60, letter: "C5", remark: "Credit" },
    { min: 50, max: 55, letter: "C6", remark: "Credit" },
    { min: 45, max: 50, letter: "D7", remark: "Pass" },
    { min: 40, max: 45, letter: "E8", remark: "Pass" },
    { min: 0, max: 40, letter: "F9", remark: "Fail" },
  ];
  test("the legacy A1–F9 table is valid, in any order", () => {
    expect(checkBands(WAEC)).toBeNull();
    expect(checkBands([...WAEC].reverse())).toBeNull();
    expect(checkBands([WAEC[3], WAEC[0], WAEC[8], WAEC[1], WAEC[2], WAEC[4], WAEC[5], WAEC[6], WAEC[7]])).toBeNull();
  });
  test("a single band 0–100 is valid; the smallest and the largest legal scales", () => {
    expect(checkBands([{ min: 0, max: 100, letter: "P", remark: "Pass" }])).toBeNull();
    const twelve = Array.from({ length: 12 }, (_, i) => ({ min: i * 8, max: i === 11 ? 100 : (i + 1) * 8, letter: `G${i}`, remark: "x" }));
    expect(checkBands(twelve)).toBeNull();
    expect(checkBands([...twelve, { min: 100, max: 100, letter: "G12", remark: "x" }])).toMatchObject({ problem: "TOO_MANY_BANDS" });
  });
  test("decimals are first-class: 0–59.5 / 59.5–100 is valid and has NO gap at 59.7; 0–59.5 / 59.6–100 has one", () => {
    expect(
      checkBands([
        { min: 0, max: 59.5, letter: "F", remark: "Fail" },
        { min: 59.5, max: 100, letter: "P", remark: "Pass" },
      ]),
    ).toBeNull();
    expect(
      checkBands([
        { min: 0, max: 59.5, letter: "F", remark: "Fail" },
        { min: 59.6, max: 100, letter: "P", remark: "Pass" },
      ]),
    ).toMatchObject({ problem: "GAP", index: 1 });
    expect(
      checkBands([
        { min: 0, max: 59.505, letter: "F", remark: "Fail" },
        { min: 59.505, max: 100, letter: "P", remark: "Pass" },
      ]),
    ).toMatchObject({ problem: "PRECISION", index: 0 });
  });
  test("each failure names itself and the band: a gap, an overlap, adjacent-but-overlapping by a hundredth, an inverted band, an empty band, above 100, below 0, not starting at 0, not ending at 100", () => {
    const f = (min: number, max: number, letter: string): BandInput => ({ min, max, letter, remark: "r" });
    expect(checkBands([f(0, 50, "F"), f(51, 100, "P")])).toMatchObject({ problem: "GAP", index: 1 });
    expect(checkBands([f(0, 50, "F"), f(49, 100, "P")])).toMatchObject({ problem: "OVERLAP", index: 1 });
    expect(checkBands([f(0, 50.01, "F"), f(50, 100, "P")])).toMatchObject({ problem: "OVERLAP" }); // by one hundredth
    expect(checkBands([f(0, 50, "F"), f(50, 49, "P")])).toMatchObject({ problem: "NOT_ASCENDING", index: 1 });
    expect(checkBands([f(0, 50, "F"), f(50, 50, "P"), f(50, 100, "Q")])).toMatchObject({ problem: "NOT_ASCENDING", index: 1 });
    expect(checkBands([f(0, 50, "F"), f(50, 101, "P")])).toMatchObject({ problem: "OUT_OF_RANGE", index: 1 });
    expect(checkBands([f(-1, 50, "F"), f(50, 100, "P")])).toMatchObject({ problem: "OUT_OF_RANGE", index: 0 });
    expect(checkBands([f(1, 50, "F"), f(50, 100, "P")])).toMatchObject({ problem: "STARTS_ABOVE_ZERO" });
    expect(checkBands([f(0, 50, "F"), f(50, 99.99, "P")])).toMatchObject({ problem: "ENDS_BELOW_HUNDRED", index: 1 });
    expect(checkBands([])).toMatchObject({ problem: "NO_BANDS" });
    expect(checkBands([f(0, 50, "F"), f(0, 50, "P"), f(50, 100, "Q")])).toMatchObject({ problem: "OVERLAP" }); // two identical ranges
  });
  test("letters and remarks: 1–4 characters / 1–40, letters unique ignoring case", () => {
    const f = (letter: string, remark: string, min: number, max: number): BandInput => ({ min, max, letter, remark });
    expect(checkBands([f("", "r", 0, 100)])).toMatchObject({ problem: "LETTER_INVALID" });
    expect(checkBands([f("ABCDE", "r", 0, 100)])).toMatchObject({ problem: "LETTER_INVALID" });
    expect(checkBands([f("ABCD", "r", 0, 100)])).toBeNull();
    expect(checkBands([f("A", "r", 0, 50), f("a", "r", 50, 100)])).toMatchObject({ problem: "LETTER_DUPLICATE", index: 1 });
    expect(checkBands([f("A", "", 0, 100)])).toMatchObject({ problem: "REMARK_INVALID" });
    expect(checkBands([f("A", "x".repeat(41), 0, 100)])).toMatchObject({ problem: "REMARK_INVALID" });
    expect(checkBands([f("A", "x".repeat(40), 0, 100)])).toBeNull();
  });
});

test.describe("gradeFor — the only way a score becomes a letter", () => {
  const bands = [
    { min: 0, max: 40, letter: "F9" },
    { min: 40, max: 70, letter: "C" },
    { min: 70, max: 100, letter: "A" },
  ];
  test("at every edge: the lower bound belongs to the band ABOVE, the upper bound is excluded — and 100 is in the top band", () => {
    const letter = (score: number) => gradeFor(bands, score)?.letter ?? null;
    expect(letter(0)).toBe("F9");
    expect(letter(39.99)).toBe("F9");
    expect(letter(40)).toBe("C");
    expect(letter(69.99)).toBe("C");
    expect(letter(70)).toBe("A");
    expect(letter(99.99)).toBe("A");
    expect(letter(100)).toBe("A");
  });
  test("outside 0–100, or not a clean two-decimal number, belongs to NO band", () => {
    for (const score of [-0.01, 100.01, 101, -5, NaN, Infinity, 50.005, 0.1 + 0.2])
      expect(gradeFor(bands, score), String(score)).toBeNull();
    expect(gradeFor(bands, "50" as never)).toBeNull();
  });
  test("every score from 0.00 to 100.00 in steps of 0.01 lands in EXACTLY one band of a valid scale (no gap, no overlap, for any decimal)", () => {
    const scale: BandInput[] = [
      { min: 0, max: 33.33, letter: "C", remark: "r" },
      { min: 33.33, max: 66.67, letter: "B", remark: "r" },
      { min: 66.67, max: 100, letter: "A", remark: "r" },
    ];
    expect(checkBands(scale)).toBeNull();
    for (let hundredths = 0; hundredths <= 10000; hundredths++) {
      const score = hundredths / 100;
      const hits = scale.filter((band) => gradeFor([band], score) !== null);
      expect(hits, String(score)).toHaveLength(1);
    }
  });
});
