// The pure rules of people records (plan "Build design — Phase 1.2", reconciliations 5–6 and decisions P3, P4, P8). No database, no clock: the
// clock is an argument wherever a date is compared with "today". Every boundary is unit-tested.

import { cleanName, isIsoDate } from "@/lib/academics/rules";

export const NAME_MAX = 80;
export const ADMISSION_NO_MAX = 30;
/// The first calendar day a date of birth may have (matches the database CHECK).
export const EARLIEST_BIRTH_DATE = "1900-01-01";

/// A person's name part: 1–80 characters once trimmed and whitespace-collapsed, no control characters.
export function cleanPersonName(value: unknown): string | null {
  const name = cleanName(value, NAME_MAX);
  return name && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

/// An optional name part (a middle name): blank or absent → `null` (nothing), a bad value → `undefined` so the caller can tell "none" from "invalid".
export function cleanOptionalName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return cleanPersonName(value) ?? undefined;
}

/// A phone number as typed: 7–20 characters of digits, spaces and `+ - ( )`, with at least 7 digits; stored trimmed. Anything else → null.
export function cleanPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length < 7 || text.length > 20 || !/^[0-9+()\- ]+$/.test(text)) return null;
  return text.replace(/\D/g, "").length >= 7 ? text : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/// An email address, lower-cased, ≤ 254 characters, one `@`, a dot in the domain, no spaces. (Whoever the address is for proves it later, by opening a link.)
export function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return text.length <= 254 && EMAIL.test(text) ? text : null;
}

/// An optional contact field: blank or absent → null; invalid → undefined (as `cleanOptionalName`).
export function cleanOptional<T>(value: unknown, clean: (value: unknown) => T | null): T | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return clean(value) ?? undefined;
}

/// Today as `YYYY-MM-DD` in UTC. The only clock read in this file, and its caller passes the instant in.
export const todayIso = (now: Date | number = Date.now()): string => new Date(now).toISOString().slice(0, 10);

export type BirthDateProblem = "INVALID" | "TOO_EARLY" | "IN_FUTURE";

/// A date of birth is a real day, from 1900-01-01 up to and including today (the school's clock is the server's, in UTC).
export function checkBirthDate(value: unknown, now: Date | number = Date.now()): BirthDateProblem | null {
  if (!isIsoDate(value)) return "INVALID";
  if (value < EARLIEST_BIRTH_DATE) return "TOO_EARLY";
  return value > todayIso(now) ? "IN_FUTURE" : null;
}

const ADMISSION_NO = /^[A-Za-z0-9][A-Za-z0-9/.-]*$/;
/// A typed admission number: 1–30 characters of letters, digits and `/ - .`, starting with a letter or digit. Case is kept as typed; uniqueness is case-insensitive.
export function cleanAdmissionNo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= 1 && text.length <= ADMISSION_NO_MAX && ADMISSION_NO.test(text) ? text : null;
}

/// The generated form: `YYYY/NNNN` — the sequence padded to four digits and growing past 9999 (decision P3).
export const formatAdmissionNo = (year: number, sequence: number): string => `${year}/${String(sequence).padStart(4, "0")}`;

/// The most times the generator steps over numbers somebody typed first, before it refuses (decision P3).
export const ADMISSION_RETRY_LIMIT = 50;

/// What makes two students "the same person" for the duplicate check (decision P4): first name, last name and date of birth, trimmed, whitespace-collapsed,
/// case-insensitive. The middle name is deliberately NOT part of it (it is optional and often missing on one of the two records).
export function duplicateKey(firstName: string, lastName: string, dateOfBirth: string): string {
  const part = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  return `${part(firstName)}|${part(lastName)}|${dateOfBirth}`;
}

/// The relationship a guardian has to a student.
export const RELATIONSHIPS = ["MOTHER", "FATHER", "GUARDIAN", "OTHER"] as const;
export type RelationshipName = (typeof RELATIONSHIPS)[number];
