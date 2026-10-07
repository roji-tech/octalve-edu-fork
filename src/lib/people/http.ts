import { z } from "zod";
import { fail } from "@/lib/api/envelope";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import type { PeopleFailure } from "@/lib/people/results";

// The HTTP face of the people rules: one place that turns a refusal into a status, a stable `code` and words a person can act on. As in the academic
// routes, an unknown id, another school's id and another campus's id share ONE answer (NOT_FOUND).

/// Who may read people (decision P2); only an ADMIN writes them.
export { READ_ROLES, WRITE_ROLES, isPlausibleId, notFound, idField } from "@/lib/academics/http";

export const textField = z.string({ error: "Give some text." }).max(200, "That is too long.");

const WRITES_PER_WINDOW = 240;
/// One administrator's writes to people are limited like the other admin surfaces: a runaway client cannot hammer the register.
export async function peopleWriteLimited(auth: TenantAuthContext): Promise<Response | null> {
  if (await reserveAttempt(`people:write:${auth.tenant.tenantId}:${auth.userId}`, WRITES_PER_WINDOW)) return null;
  return fail("Too many changes. Please try again in a few minutes.", 429, "RATE_LIMITED");
}

const FIELD_MESSAGES: Record<string, string> = {
  firstName: "Give a first name of 1 to 80 characters.",
  middleName: "A middle name is 1 to 80 characters, or leave it empty.",
  lastName: "Give a last name of 1 to 80 characters.",
  dateOfBirth: "Give a real date of birth, written YYYY-MM-DD, from 1900 up to today.",
  admissionNo: "An admission number is 1 to 30 letters, digits, / - or . and starts with a letter or digit.",
  reason: "Give a reason of 5 to 300 characters.",
  phone: "A phone number has 7 to 20 digits, spaces, + - or brackets.",
  email: "Give a valid email address.",
  relationship: "Choose mother, father, guardian or other.",
  category: "Choose teaching or non-teaching.",
};

export function peopleFailure(reason: PeopleFailure, detail?: Record<string, unknown>, what = "student"): Response {
  switch (reason) {
    case "NOT_FOUND":
      return fail(`No such ${what}.`, 404, "NOT_FOUND");
    case "INVALID_CAMPUS":
      return fail("Choose one of this school's campuses.", 400, "VALIDATION", [
        { path: "body.campusId", message: "Choose one of this school's campuses." },
      ]);
    case "INVALID": {
      const field = String(detail?.field ?? "body");
      const message = FIELD_MESSAGES[field] ?? "Check this value.";
      return fail(message, 400, "VALIDATION", [{ path: `body.${field}`, message }]);
    }
    case "POSSIBLE_DUPLICATE":
      return fail(
        `A student with the same name and date of birth already exists${detail?.admissionNo ? ` (admission number ${String(detail.admissionNo)})` : ""}.`,
        409,
        "POSSIBLE_DUPLICATE",
        detail?.admissionNo ? [{ path: "body.firstName", message: `Already exists as ${String(detail.admissionNo)}.` }] : undefined,
      );
    case "ADMISSION_NUMBER_TAKEN":
      return fail("That admission number is already used.", 409, "ADMISSION_NUMBER_TAKEN", [
        { path: "body.admissionNo", message: "That admission number is already used." },
      ]);
    case "ADMISSION_NUMBER_EXHAUSTED":
      return fail("No free admission number could be generated. Type one instead.", 409, "ADMISSION_NUMBER_EXHAUSTED");
    case "ARCHIVED":
      return fail("It is archived. Restore it first.", 409, "ARCHIVED");
    case "NOT_ARCHIVED":
      return fail("It is not archived.", 409, "NOT_ARCHIVED");
    case "WRONG_STATE":
      return fail("That can't be done to it in its current state.", 409, "WRONG_STATE");
    case "HAS_ACTIVE_ENROLMENT":
      return fail("The student is still enrolled. Withdraw them from the class first.", 409, "HAS_ACTIVE_ENROLMENT");
    case "INVALID_SESSION":
      return fail("Choose a session that belongs to this student's campus or to the whole school.", 400, "VALIDATION", [
        { path: "body.sessionId", message: "Choose a session for this student." },
      ]);
    case "SESSION_CLOSED":
      return fail("That session is closed or archived, so nobody can be enrolled in it.", 409, "SESSION_CLOSED");
    case "INVALID_ARM":
      return fail("Choose a class that belongs to this student's campus or to the whole school.", 400, "VALIDATION", [
        { path: "body.classArmId", message: "Choose a class for this student." },
      ]);
    case "ALREADY_ENROLLED":
      return fail(
        `Already enrolled in ${detail?.className ? `${String(detail.className)} ${String(detail.armName)}` : "a class"} for that session. Move them instead.`,
        409,
        "ALREADY_ENROLLED",
        [{ path: "body.sessionId", message: "Already enrolled for this session." }],
      );
    default:
      return fail("That can't be done.", 409, reason);
  }
}
