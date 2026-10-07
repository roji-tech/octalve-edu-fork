import "../support/env";
import { test, expect } from "@playwright/test";
import {
  ADMISSION_NO_MAX,
  ADMISSION_RETRY_LIMIT,
  checkBirthDate,
  cleanAdmissionNo,
  cleanEmail,
  cleanOptional,
  cleanOptionalName,
  cleanPersonName,
  cleanPhone,
  duplicateKey,
  formatAdmissionNo,
  todayIso,
} from "@/lib/people/rules";
import { defaultSchoolType } from "@/lib/setup/school-type";

// Plan "Build design — Phase 1.2": the pure rules of people records. Every boundary is spelled out.

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0); // 2026-10-07

test.describe("names", () => {
  test("a name part is 1–80 characters once trimmed and collapsed, with no control characters", () => {
    expect(cleanPersonName("Amina")).toBe("Amina");
    expect(cleanPersonName("  Mary   Jane ")).toBe("Mary Jane");
    expect(cleanPersonName("a")).toBe("a");
    expect(cleanPersonName("a".repeat(80))).toBe("a".repeat(80));
    expect(cleanPersonName("a".repeat(81))).toBeNull();
    for (const bad of ["", "   ", "\u0007x", null, undefined, 5, {}]) expect(cleanPersonName(bad), String(bad)).toBeNull();
  });

  test("an optional name is nothing when blank, undefined when invalid", () => {
    expect(cleanOptionalName(undefined)).toBeNull();
    expect(cleanOptionalName(null)).toBeNull();
    expect(cleanOptionalName("   ")).toBeNull();
    expect(cleanOptionalName(" Ade ")).toBe("Ade");
    expect(cleanOptionalName("a".repeat(81))).toBeUndefined();
    expect(cleanOptionalName(7)).toBeUndefined();
  });
});

test.describe("contact details", () => {
  test("a phone is 7–20 characters of digits, spaces and + - ( ), with at least 7 digits", () => {
    expect(cleanPhone("08031234567")).toBe("08031234567");
    expect(cleanPhone(" +234 803 123 4567 ")).toBe("+234 803 123 4567");
    expect(cleanPhone("1234567")).toBe("1234567");
    expect(cleanPhone("123456")).toBeNull();
    expect(cleanPhone("(0)-1-2-3-4-5")).toBeNull(); // 6 digits, 13 characters
    expect(cleanPhone("(0)-1-2-3-4-5-6")).toBe("(0)-1-2-3-4-5-6"); // 7 digits
    expect(cleanPhone("1".repeat(20))).toBe("1".repeat(20));
    expect(cleanPhone("1".repeat(21))).toBeNull();
    for (const bad of ["abcdefghij", "0803 123 456x", "080;31234567", "", null, 8031234567])
      expect(cleanPhone(bad), String(bad)).toBeNull();
  });

  test("an email is lower-cased, has one @ and a dot in the domain, ≤ 254 characters", () => {
    expect(cleanEmail("  Ade@Example.COM ")).toBe("ade@example.com");
    expect(cleanEmail(`${"a".repeat(242)}@example.com`)).toBe(`${"a".repeat(242)}@example.com`); // 254
    expect(cleanEmail(`${"a".repeat(243)}@example.com`)).toBeNull(); // 255
    for (const bad of ["ade", "ade@", "@example.com", "ade@example", "a b@example.com", "a@@example.com", "", null]) {
      expect(cleanEmail(bad), String(bad)).toBeNull();
    }
  });

  test("cleanOptional tells blank from invalid", () => {
    expect(cleanOptional(undefined, cleanPhone)).toBeNull();
    expect(cleanOptional("  ", cleanPhone)).toBeNull();
    expect(cleanOptional("08031234567", cleanPhone)).toBe("08031234567");
    expect(cleanOptional("12", cleanPhone)).toBeUndefined();
  });
});

test.describe("date of birth", () => {
  test("a real day from 1900-01-01 up to and including today", () => {
    expect(todayIso(NOW)).toBe("2026-10-07");
    expect(checkBirthDate("2026-10-07", NOW)).toBeNull();
    expect(checkBirthDate("2026-10-08", NOW)).toBe("IN_FUTURE");
    expect(checkBirthDate("1900-01-01", NOW)).toBeNull();
    expect(checkBirthDate("1899-12-31", NOW)).toBe("TOO_EARLY");
    expect(checkBirthDate("2012-02-30", NOW)).toBe("INVALID");
    for (const bad of ["12/05/2012", "2012-5-1", "", null, 2012]) expect(checkBirthDate(bad, NOW), String(bad)).toBe("INVALID");
  });

  test("today is read in UTC, so 23:59 UTC is still the same day", () => {
    expect(checkBirthDate("2026-10-07", Date.UTC(2026, 9, 7, 23, 59, 59))).toBeNull();
    expect(checkBirthDate("2026-10-07", Date.UTC(2026, 9, 6, 23, 59, 59))).toBe("IN_FUTURE");
  });
});

test.describe("admission numbers", () => {
  test("a typed number is 1–30 characters of letters, digits and / - . starting with a letter or digit", () => {
    for (const ok of ["1", "2026/0001", "JSS1-A.07", "a/b", "A".repeat(ADMISSION_NO_MAX)]) expect(cleanAdmissionNo(ok), ok).toBe(ok);
    expect(cleanAdmissionNo("  2026/7  ")).toBe("2026/7");
    for (const bad of ["", "   ", "A".repeat(ADMISSION_NO_MAX + 1), "/2026", "-1", ".1", "20 26", "20_26", "٢٠٢٦", null, 12]) {
      expect(cleanAdmissionNo(bad), String(bad)).toBeNull();
    }
  });

  test("the generated form pads to four digits and grows past 9999", () => {
    expect(formatAdmissionNo(2026, 1)).toBe("2026/0001");
    expect(formatAdmissionNo(2026, 42)).toBe("2026/0042");
    expect(formatAdmissionNo(2026, 9999)).toBe("2026/9999");
    expect(formatAdmissionNo(2026, 10000)).toBe("2026/10000");
  });

  test("the retry bound is 50", () => {
    expect(ADMISSION_RETRY_LIMIT).toBe(50);
  });
});

test.describe("duplicate key", () => {
  test("ignores case, surrounding and repeated spaces; includes the date; ignores the middle name", () => {
    expect(duplicateKey("  Amina ", "Bello", "2012-05-01")).toBe(duplicateKey("amina", "BELLO", "2012-05-01"));
    expect(duplicateKey("Mary  Jane", "Bello", "2012-05-01")).toBe(duplicateKey("mary jane", "Bello", "2012-05-01"));
    expect(duplicateKey("Amina", "Bello", "2012-05-01")).not.toBe(duplicateKey("Amina", "Bello", "2012-05-02"));
    expect(duplicateKey("Amina", "Bello", "2012-05-01")).not.toBe(duplicateKey("Aminah", "Bello", "2012-05-01"));
    // The name parts cannot be shifted across the separator to collide: "a|b" + "c" is not "a" + "b|c" (the parts never contain the separator after validation, and the key is order-sensitive).
    expect(duplicateKey("Ade", "Bello", "2012-05-01")).not.toBe(duplicateKey("Bello", "Ade", "2012-05-01"));
  });
});

test.describe("DEFAULT_SCHOOL_TYPE", () => {
  test("unset or blank is K12; the three values are accepted exactly; anything else throws", () => {
    expect(defaultSchoolType({})).toBe("K12");
    expect(defaultSchoolType({ DEFAULT_SCHOOL_TYPE: "" })).toBe("K12");
    expect(defaultSchoolType({ DEFAULT_SCHOOL_TYPE: "  " })).toBe("K12");
    expect(defaultSchoolType({ DEFAULT_SCHOOL_TYPE: "K12" })).toBe("K12");
    expect(defaultSchoolType({ DEFAULT_SCHOOL_TYPE: " HIGHER_ED " })).toBe("HIGHER_ED");
    expect(defaultSchoolType({ DEFAULT_SCHOOL_TYPE: "VOCATIONAL" })).toBe("VOCATIONAL");
    for (const bad of ["k12", "Vocational", "HIGHER-ED", "SECONDARY", "0"]) {
      expect(() => defaultSchoolType({ DEFAULT_SCHOOL_TYPE: bad }), bad).toThrow(
        /DEFAULT_SCHOOL_TYPE must be one of K12, HIGHER_ED, VOCATIONAL/,
      );
    }
  });
});
