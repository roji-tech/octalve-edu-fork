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
    case "SESSION_NOT_ACTIVE":
      return fail("Only a term of the active session can be the current one.", 409, "SESSION_NOT_ACTIVE");
  }
}
