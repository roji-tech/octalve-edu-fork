import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, idField, peopleFailure, peopleWriteLimited, textField } from "@/lib/people/http";
import { createStudent, listStudents } from "@/lib/people/students";

// GET  /api/v1/schools/[code]/people/students   — the school's students, A to Z. ?q= (names or admission number), ?status=live|archived|all (default live), ?campusId=,
//        ?sessionId= with ?classArmId= (enrolled in that class that session) or ?notEnrolled=true; each student carries its enrolment in ?sessionId.
// POST /api/v1/schools/[code]/people/students   { campusId?, firstName, middleName?, lastName, dateOfBirth, admissionNo? } — ADMIN only. Without admissionNo one is generated.
// Reads: ADMIN and staff (staff see school-wide students and their own campus's).
const query = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(["live", "archived", "all"]).default("live"),
  campusId: idField.optional(),
  sessionId: idField.optional(),
  classArmId: idField.optional(),
  notEnrolled: z.enum(["true"]).optional(),
});
const createBody = z.strictObject({
  campusId: idField.nullable().optional(),
  firstName: textField,
  middleName: textField.nullable().optional(),
  lastName: textField,
  dateOfBirth: z.string({ error: "Give a date of birth." }).max(20),
  admissionNo: z.string().max(100).nullable().optional(),
  allowDuplicate: z.boolean().optional(),
});

export const GET = withAuth(
  validate({ query }, async (req, auth: TenantAuthContext, _ctx: unknown, { query: filters }) => {
    const page = parseOffsetPagination(req.nextUrl.searchParams);
    if (!page.ok)
      return fail(
        "Some of the query parameters are not valid.",
        400,
        "VALIDATION",
        page.issues.map((i) => ({ ...i, path: `query.${i.path}` })),
      );
    const { students, total } = await listStudents(auth.tenant, { ...filters, notEnrolled: filters.notEnrolled === "true" }, page);
    return ok({ students }, offsetMeta({ page: page.page, limit: page.limit, total }));
  }),
  { tenant: true, roles: READ_ROLES },
);

export const POST = withAuth(
  validate({ body: createBody }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body }) => {
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await createStudent(auth.tenant, auth.userId, body);
    return result.ok ? ok({ student: result.student }, {}, 201) : peopleFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
