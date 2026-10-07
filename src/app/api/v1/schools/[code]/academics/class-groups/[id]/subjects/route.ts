import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, academicFailure, idField, isPlausibleId, notFound, writeLimited } from "@/lib/academics/http";
import { listOfferings, setOfferings } from "@/lib/academics/classes";

// GET /api/v1/schools/[code]/academics/class-groups/[id]/subjects  — the subjects this class studies.
// PUT /api/v1/schools/[code]/academics/class-groups/[id]/subjects  { subjectIds } — ADMIN only; the FULL list (idempotent: a repeat changes nothing).
// Every id must be a live subject of this school, or the whole request is refused.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({ subjectIds: z.array(idField).max(100) });

export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("class");
    const result = await listOfferings(auth.tenant, id);
    return result.ok ? ok({ subjects: result.subjects }) : academicFailure(result.reason, result.detail, "class");
  },
  { tenant: true, roles: READ_ROLES },
);

export const PUT = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("class");
    const limited = await writeLimited(auth);
    if (limited) return limited;
    const result = await setOfferings(auth.tenant, auth.userId, id, input.subjectIds);
    return result.ok ? ok({ subjects: result.subjects, changed: result.changed }) : academicFailure(result.reason, result.detail, "class");
  }),
  { tenant: true, roles: WRITE_ROLES },
);
