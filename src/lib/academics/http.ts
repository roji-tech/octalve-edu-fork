import { z } from "zod";
import { fail } from "@/lib/api/envelope";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { isIsoDate } from "@/lib/academics/rules";
import type { AcademicFailure } from "@/lib/academics/sessions";

// The HTTP face of the academic-structure rules: one place that turns a refusal into a status, a stable `code` and words a person can act
// on. An unknown id, another school's id and another campus's id share ONE answer (NOT_FOUND) — see sessions.ts.

/// Who may read the academic structure (decision 7); only an ADMIN writes it.
export const READ_ROLES = ["ADMIN", "TEACHING_STAFF", "NON_TEACHING_STAFF"] as const;
export const WRITE_ROLES = ["ADMIN"] as const;

/// A path parameter that cannot be an id of ours is the same "no such thing" as one that merely does not exist.
export const isPlausibleId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
export const notFound = (what: string) => fail(`No such ${what}.`, 404, "NOT_FOUND");

export const isoDateField = z.string({ error: "Give a date as YYYY-MM-DD." }).refine(isIsoDate, "Use a real date, written YYYY-MM-DD.");
export const nameField = z.string({ error: "Give a name." }).max(200, "That is too long.");
export const idField = z.string().min(1).max(64);

/// A mark or band edge is a plain JSON number; the rules (at most two decimals, the ranges, the sum) are judged by lib/academics/scoring.ts.
export const markField = z.number({ error: "Give a number." });
export const componentsField = z
  .array(z.strictObject({ name: z.string({ error: "Give a name." }).max(200, "That is too long."), maxScore: markField }), {
    error: "Give the components as a list.",
  })
  .max(50, "That is too many.");
export const bandsField = z
  .array(
    z.strictObject({
      min: markField,
      max: markField,
      letter: z.string({ error: "Give a letter." }).max(40, "That is too long."),
      remark: z.string({ error: "Give a remark." }).max(200, "That is too long."),
    }),
    { error: "Give the bands as a list." },
  )
  .max(50, "That is too many.");

const WRITES_PER_WINDOW = 120;
/// One administrator's writes to the academic structure are limited like the Users page's: a runaway client cannot hammer the calendar.
export async function writeLimited(auth: TenantAuthContext): Promise<Response | null> {
  if (await reserveAttempt(`academics:write:${auth.tenant.tenantId}:${auth.userId}`, WRITES_PER_WINDOW)) return null;
  return fail("Too many changes. Please try again in a few minutes.", 429, "RATE_LIMITED");
}

const DATE_PROBLEMS: Record<string, { path: string; message: string }> = {
  START_INVALID: { path: "body.startDate", message: "Use a real start date, written YYYY-MM-DD." },
  END_INVALID: { path: "body.endDate", message: "Use a real end date, written YYYY-MM-DD." },
  END_NOT_AFTER_START: { path: "body.endDate", message: "The end must be after the start." },
  END_REQUIRED: { path: "body.endDate", message: "A term or semester needs an end date." },
  OUTSIDE_SESSION: { path: "body.startDate", message: "The dates must fall inside the session." },
  ORDINAL_INVALID: { path: "body.ordinal", message: "The position must be a whole number from 1 to 99." },
};

export function academicFailure(reason: AcademicFailure, detail?: Record<string, unknown>, what = "session"): Response {
  switch (reason) {
    case "NOT_FOUND":
      return notFound(what);
    case "INVALID_CAMPUS":
      return fail("Choose one of this school's campuses.", 400, "VALIDATION", [
        { path: "body.campusId", message: "Choose one of this school's campuses." },
      ]);
    case "INVALID_LABEL":
      return fail("Give it a name of 1 to 60 characters.", 400, "VALIDATION", [
        { path: "body.label", message: "Give it a name (not blank, not too long)." },
      ]);
    case "INVALID_DATES": {
      const issue = DATE_PROBLEMS[String(detail?.problem)] ?? { path: "body.startDate", message: "Check the dates." };
      return fail(issue.message, 400, "VALIDATION", [issue]);
    }
    case "LABEL_TAKEN":
      return fail("That name is already used here.", 409, "LABEL_TAKEN", [
        { path: "body.label", message: "That name is already used here." },
      ]);
    case "ORDINAL_TAKEN":
      return fail("Another period already has that position.", 409, "ORDINAL_TAKEN", [
        { path: "body.ordinal", message: "Another period already has that position." },
      ]);
    case "OVERLAP":
      return fail(`The dates overlap with ${detail?.label ? `"${String(detail.label)}"` : "another one"}.`, 409, "OVERLAP");
    case "SESSION_ALREADY_ACTIVE":
      return fail(
        `"${String(detail?.label ?? "Another session")}" is already the active session. Close it first, or choose to close it and open this one.`,
        409,
        "SESSION_ALREADY_ACTIVE",
      );
    case "INVALID_REASON":
      return fail("Give a reason of 5 to 300 characters.", 400, "VALIDATION", [
        { path: "body.reason", message: "Give a reason of 5 to 300 characters." },
      ]);
    case "WRONG_STATE":
      return fail("That can't be done to it in its current state.", 409, "WRONG_STATE");
    case "ARCHIVED":
      return fail("It is archived. Archived items can no longer be changed.", 409, "ARCHIVED");
    case "CLOSED_READONLY":
      return fail("The session is closed, so it can no longer be changed.", 409, "CLOSED_READONLY");
    case "ACTIVE_CANNOT_ARCHIVE":
      return fail("An active session can't be archived. Close it first.", 409, "ACTIVE_CANNOT_ARCHIVE");
    case "PERIODS_OUTSIDE":
      return fail("Some of its terms would fall outside the new dates. Change those terms first.", 409, "PERIODS_OUTSIDE");
    case "TOO_MANY_PERIODS":
      return fail("A session can have at most twelve terms.", 409, "TOO_MANY_PERIODS");
    case "ALREADY_COPIED":
      return fail("This session has already been copied forward.", 409, "ALREADY_COPIED");
    case "INVALID_NAME":
      return fail("Give it a name (not blank, not too long).", 400, "VALIDATION", [
        { path: "body.name", message: "Give it a name (not blank, not too long)." },
      ]);
    case "INVALID_CAPACITY":
      return fail("Capacity must be a whole number from 1 to 1000, or left empty.", 400, "VALIDATION", [
        { path: "body.capacity", message: "A whole number from 1 to 1000, or empty for no limit." },
      ]);
    case "INVALID_SORT_ORDER":
      return fail("The order must be a whole number from 0 to 999.", 400, "VALIDATION", [
        { path: "body.sortOrder", message: "A whole number from 0 to 999." },
      ]);
    case "INVALID_CODE":
      return fail("A subject code is 1 to 12 letters or digits.", 400, "VALIDATION", [
        { path: "body.code", message: "1 to 12 letters or digits, no spaces." },
      ]);
    case "NAME_TAKEN":
      return fail("That name is already used here.", 409, "NAME_TAKEN", [
        { path: "body.name", message: "That name is already used here." },
      ]);
    case "CODE_TAKEN":
      return fail("That code is already used by another subject.", 409, "CODE_TAKEN", [
        { path: "body.code", message: "That code is already used by another subject." },
      ]);
    case "HAS_ACTIVE_ARMS":
      return fail("This class still has arms. Archive its arms first.", 409, "HAS_ACTIVE_ARMS");
    case "SUBJECT_IN_USE":
      return fail("A class still studies this subject. Remove it from those classes first.", 409, "SUBJECT_IN_USE");
    case "UNKNOWN_SUBJECT":
      return fail("Some of those subjects do not exist here.", 400, "VALIDATION", [
        { path: "body.subjectIds", message: "Choose from this school's subjects." },
      ]);
    case "TOO_MANY_ARMS":
      return fail("A class can have at most 26 arms.", 409, "TOO_MANY_ARMS");
    case "SCHEME_INVALID": {
      const problem = String(detail?.problem);
      const sum = detail?.sum;
      const MESSAGES: Record<string, string> = {
        PRECISION: "Marks can have at most two decimal places.",
        TOTAL_NOT_POSITIVE: "The total must be more than zero.",
        EXAM_NEGATIVE: "The exam mark can't be negative.",
        NO_COMPONENTS: "Add at least one component.",
        TOO_MANY_COMPONENTS: "A scheme can have at most ten components.",
        COMPONENT_NAME_INVALID: "Give each component a name of 1 to 40 characters.",
        COMPONENT_NAME_DUPLICATE: "Two components have the same name.",
        COMPONENT_MAX_NOT_POSITIVE: "Each component's maximum must be more than zero.",
        SUM_MISMATCH: `The components and the exam add up to ${sum ?? "a different number"}, not the total.`,
      };
      const message = MESSAGES[problem] ?? "Check the scheme.";
      const path =
        problem === "SUM_MISMATCH"
          ? "body.examMax"
          : problem.startsWith("COMPONENT") || (problem === "PRECISION" && detail?.index !== undefined)
            ? `body.components.${String(detail?.index ?? 0)}`
            : problem.startsWith("EXAM")
              ? "body.examMax"
              : problem.startsWith("TOTAL")
                ? "body.totalMax"
                : "body.components";
      return fail(message, 400, "VALIDATION", [{ path, message }]);
    }
    case "BANDS_INVALID": {
      const problem = String(detail?.problem);
      const MESSAGES: Record<string, string> = {
        NO_BANDS: "Add at least one band.",
        TOO_MANY_BANDS: "A scale can have at most twelve bands.",
        PRECISION: "Scores can have at most two decimal places.",
        OUT_OF_RANGE: "Scores must be between 0 and 100.",
        NOT_ASCENDING: "A band must end above where it starts.",
        GAP: "There is a gap before this band — every score from 0 to 100 needs a band.",
        OVERLAP: "This band overlaps another.",
        STARTS_ABOVE_ZERO: "The lowest band must start at 0.",
        ENDS_BELOW_HUNDRED: "The highest band must end at 100.",
        LETTER_INVALID: "Give each band a letter of 1 to 4 characters.",
        LETTER_DUPLICATE: "Two bands have the same letter.",
        REMARK_INVALID: "Give each band a remark of 1 to 40 characters.",
      };
      const message = MESSAGES[problem] ?? "Check the bands.";
      return fail(message, 400, "VALIDATION", [
        { path: detail?.index === undefined ? "body.bands" : `body.bands.${String(detail.index)}`, message },
      ]);
    }
    case "LOCKED":
      return fail("Results already use this, so it can't be edited. Make a new version instead.", 409, "LOCKED");
    case "NOT_LOCKED":
      return fail("Nothing uses this yet, so edit it directly instead of making a new version.", 409, "NOT_LOCKED");
    case "UNKNOWN_CLASS_GROUP":
      return fail("Choose one of this school's classes.", 400, "VALIDATION", [
        { path: "body.classGroupId", message: "Choose one of this school's classes." },
      ]);
    case "SCOPE_TAKEN":
      return fail("That class (or the school as a whole) already has a scheme. Archive or edit it instead.", 409, "SCOPE_TAKEN");
    case "DEFAULT_CANNOT_ARCHIVE":
      return fail("This is the school's default scale. Make another scale the default first.", 409, "DEFAULT_CANNOT_ARCHIVE");
    case "SESSION_NOT_ACTIVE":
      return fail("Only a term of the active session can be the current one.", 409, "SESSION_NOT_ACTIVE");
  }
}
