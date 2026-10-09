import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, idField, peopleFailure } from "@/lib/people/http";
import { armOccupancy } from "@/lib/people/students";

// GET /api/v1/schools/[code]/people/enrolment-counts?sessionId=  — how many students are actively enrolled in each class (arm) that session: { counts: { [armId]: n } }.
// Capacity is displayed against these numbers and never enforced (plan 1.2, decision P7).
const query = z.object({ sessionId: idField });

export const GET = withAuth(
  validate({ query }, async (_req, auth: TenantAuthContext, _ctx: unknown, { query: input }) => {
    const result = await armOccupancy(auth.tenant, input.sessionId);
    return result.ok ? ok({ counts: result.counts }) : peopleFailure(result.reason, result.detail, "session");
  }),
  { tenant: true, roles: READ_ROLES },
);
