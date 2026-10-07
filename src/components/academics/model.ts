import type { SchoolType } from "@prisma/client";
import type { CopyForwardPlan, PeriodView, SessionView } from "@/lib/academics/sessions";
import type { ArmView, ClassGroupView, SubjectView } from "@/lib/academics/classes";
import type { ComponentView, SchemeView } from "@/lib/academics/assessment";
import type { BandView, ScaleView } from "@/lib/academics/grading";

// What the "Academic setup" screens get from the academics API (plan "Build design — Phase 1.0 and 1.1"), and the small display rules around it.

export type {
  ArmView,
  BandView,
  ClassGroupView,
  ComponentView,
  CopyForwardPlan,
  PeriodView,
  ScaleView,
  SchemeView,
  SessionView,
  SubjectView,
};
export type CampusOption = { id: string; name: string };
export type PageMeta = { page: number; limit: number; total: number; pages: number; hasNext: boolean };

export const SECTIONS = [
  { key: "sessions", label: "Sessions & terms" },
  { key: "classes", label: "Classes & subjects" },
  { key: "assessment", label: "Assessment" },
  { key: "grading", label: "Grading" },
] as const;
export type SectionKey = (typeof SECTIONS)[number]["key"];
export const isSection = (value: unknown): value is SectionKey => SECTIONS.some((section) => section.key === value);

/// What a school calls the parts of its year: a school, a university, or a training centre each says it differently.
export function periodWords(schoolType: SchoolType): { one: string; many: string; One: string; Many: string } {
  const word = schoolType === "HIGHER_ED" ? "semester" : schoolType === "VOCATIONAL" ? "cohort" : "term";
  const Word = word[0].toUpperCase() + word.slice(1);
  return { one: word, many: `${word}s`, One: Word, Many: `${Word}s` };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/// "2026-09-07" → "7 Sep 2026". Dates are calendar days with no time zone, so they are shown as the same day for everyone — and spelled by this table, not
/// by the browser's locale data (which writes "Sept" in some versions and "Sep" in others, and would differ between the server render and the browser).
export const formatDate = (iso: string): string => {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
};
export const formatRange = (start: string, end: string | null): string =>
  end ? `${formatDate(start)} – ${formatDate(end)}` : `From ${formatDate(start)}`;

/// "2026-09-07" plus one year ("2027-09-07"); a 29 February becomes 28 February, as the server does.
export function plusOneYear(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const target = year + 1;
  const leap = (target % 4 === 0 && target % 100 !== 0) || target % 400 === 0;
  const safeDay = month === 2 && day === 29 && !leap ? 28 : day;
  return `${target}-${String(month).padStart(2, "0")}-${String(safeDay).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/// An instant (a scheduled close) as the viewer's own wall clock: "Wed 8 Oct, 14:05". The school has no time-zone setting yet, so this is the browser's;
/// spelled by tables like the dates, so a server render and a browser cannot disagree.
export const formatInstant = (iso: string): string => {
  const at = new Date(iso);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}, ${hh}:${mm}`;
};

export const SESSION_STATUS_LABEL = { PLANNED: "Planned", ACTIVE: "Active", CLOSED: "Closed" } as const;

/// A mark or band edge typed into a box: a finite number, or null when it is empty or not a number. (Precision and ranges are the server's rules,
/// which the screen shows as it answers; this only refuses what cannot even be sent.)
export function parseMark(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
/// A number shown in a box without a trailing ".0" (70 → "70", 12.5 → "12.5").
export const markText = (value: number): string => String(value);
