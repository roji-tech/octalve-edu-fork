import type { AssignmentView, StaffView } from "@/lib/people/staff";
import type { EnrolmentView, StudentView } from "@/lib/people/students";
import type { GuardianLinkView, GuardianView } from "@/lib/people/guardians";
import type { ImportProblem, ImportReport, ImportRow } from "@/lib/people/import";

// What the "People" screens get from the people API (plan "Build design — Phase 1.2"), and the small display rules around it.

export type {
  AssignmentView,
  EnrolmentView,
  GuardianLinkView,
  GuardianView,
  ImportProblem,
  ImportReport,
  ImportRow,
  StaffView,
  StudentView,
};
export { formatDate, type CampusOption, type PageMeta } from "@/components/academics/model";

export const SECTIONS = [
  { key: "students", label: "Students" },
  { key: "staff", label: "Staff" },
] as const;
export type SectionKey = (typeof SECTIONS)[number]["key"];
export const isSection = (value: unknown): value is SectionKey => SECTIONS.some((section) => section.key === value);

export const RELATIONSHIP_OPTIONS = [
  { value: "MOTHER", label: "Mother" },
  { value: "FATHER", label: "Father" },
  { value: "GUARDIAN", label: "Guardian" },
  { value: "OTHER", label: "Other" },
] as const;
export const RELATIONSHIP_LABEL: Record<string, string> = Object.fromEntries(RELATIONSHIP_OPTIONS.map((o) => [o.value, o.label]));

export const CATEGORY_LABEL = { TEACHING: "Teaching", NON_TEACHING: "Non-teaching" } as const;
export const ENROLMENT_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Enrolled",
  WITHDRAWN: "Withdrawn",
  PROMOTED: "Promoted",
  REPEATED: "Repeated",
  TRANSFERRED: "Transferred",
  ALUMNI: "Alumnus",
};

export const fullName = (person: { firstName: string; middleName?: string | null; lastName: string }): string =>
  [person.firstName, person.middleName, person.lastName].filter(Boolean).join(" ");

/// A class and its arm the way people say it: "JSS 1 A".
export const classLabel = (place: { classGroupName: string; armName: string }): string => `${place.classGroupName} ${place.armName}`;

/// The API's word for what is wrong with a column of the file, as one sentence.
export const problemText = (problem: ImportProblem): string => (problem.column ? `${problem.column}: ${problem.message}` : problem.message);
