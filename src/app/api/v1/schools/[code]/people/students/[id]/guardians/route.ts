import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { READ_ROLES, WRITE_ROLES, idField, isPlausibleId, notFound, peopleFailure, peopleWriteLimited, textField } from "@/lib/people/http";
import { addGuardian, listLinks } from "@/lib/people/guardians";

// GET  /api/v1/schools/[code]/people/students/[id]/guardians  — the student's guardians (live links), the primary contact first.
// POST /api/v1/schools/[code]/people/students/[id]/guardians  — ADMIN only. { guardianId, relationship, isPrimary? } links an EXISTING guardian of the school, or
//        { firstName, lastName, phone?, email?, relationship, isPrimary? } makes a NEW one and links it. Exactly one of the two. The first guardian becomes the primary contact.
type Ctx = { params: Promise<{ code: string; id: string }> };
const body = z.strictObject({
  guardianId: idField.optional(),
  firstName: textField.optional(),
  lastName: textField.optional(),
  phone: textField.nullable().optional(),
  email: textField.nullable().optional(),
  relationship: z.string({ error: "Choose mother, father, guardian or other." }).max(20),
  isPrimary: z.boolean().optional(),
});

export const GET = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("student");
    const result = await listLinks(auth.tenant, id);
    return result.ok ? ok({ guardians: result.links }) : peopleFailure(result.reason, result.detail);
  },
  { tenant: true, roles: READ_ROLES },
);

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: input }) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("student");
    const limited = await peopleWriteLimited(auth);
    if (limited) return limited;
    const result = await addGuardian(auth.tenant, auth.userId, id, input);
    return result.ok
      ? ok(
          { guardian: result.link, createdGuardian: result.createdGuardian, reactivated: result.reactivated },
          {},
          result.reactivated ? 200 : 201,
        )
      : peopleFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
