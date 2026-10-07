import { z } from "zod";
import { fail } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { WRITE_ROLES, idField, peopleFailure } from "@/lib/people/http";
import { exportStudents } from "@/lib/people/import";

// GET /api/v1/schools/[code]/people/students/export — ADMIN only. The student list's own filters (?q ?status ?campusId ?sessionId ?classArmId ?notEnrolled) as a CSV file
// (at most 10,000 rows, else 400: narrow the filter). Every cell that a spreadsheet would run as a formula is neutralised; the response is never cached; the export is
// audited (who, how many, which filters — never the search text) and limited per administrator.
const EXPORTS_PER_WINDOW = 12; // per administrator per school per 5 minutes
const query = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(["live", "archived", "all"]).default("live"),
  campusId: idField.optional(),
  sessionId: idField.optional(),
  classArmId: idField.optional(),
  notEnrolled: z.enum(["true"]).optional(),
});

export const GET = withAuth(
  validate({ query }, async (_req, auth: TenantAuthContext, _ctx: unknown, { query: filters }) => {
    if (!(await reserveAttempt(`people:export:${auth.tenant.tenantId}:${auth.userId}`, EXPORTS_PER_WINDOW))) {
      return fail("Too many exports. Please try again in a few minutes.", 429, "RATE_LIMITED");
    }
    const result = await exportStudents(auth.tenant, auth.userId, { ...filters, notEnrolled: filters.notEnrolled === "true" });
    if (!result.ok) return peopleFailure(result.reason, result.detail);
    const day = new Date().toISOString().slice(0, 10);
    return new Response(result.csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="students-${day}.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-row-count": String(result.count),
      },
    });
  }),
  { tenant: true, roles: WRITE_ROLES },
);
