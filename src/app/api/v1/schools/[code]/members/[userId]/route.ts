import { z } from "zod";
import { ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { fail } from "@/lib/api/envelope";
import { campusIdField, isPlausibleId, memberFailure, notFound, roleField } from "@/lib/members/http";
import { changeMember } from "@/lib/members/service";

// PATCH /api/v1/schools/[code]/members/[userId]  { role?, campusId? }                      (plan §0.5.4)
// Change a member's role and/or campus — ADMIN only, audited with before/after. The body is STRICT: a key it does not name (a
// `tenantId`, a `userId`, a `passwordHash`) is refused, never ignored. Authority rules live in lib/members/service.ts: nobody
// changes themselves, the last administrator cannot be demoted, a campus must be this school's. `campusId: null` clears it.
const CHANGES_PER_WINDOW = 60;
type Ctx = { params: Promise<{ code: string; userId: string }> };

const body = z
  .strictObject({ role: roleField.optional(), campusId: campusIdField.nullable().optional() })
  .refine((value) => value.role !== undefined || value.campusId !== undefined, "Give a role, a campus, or both.");

export const PATCH = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, ctx: Ctx, { body: change }) => {
    const { userId } = await ctx.params;
    if (!isPlausibleId(userId)) return notFound("member");
    if (!(await reserveAttempt(`member:change:${auth.tenant.tenantId}:${auth.userId}`, CHANGES_PER_WINDOW))) {
      return fail("Too many changes. Please try again in a few minutes.", 429, "RATE_LIMITED");
    }
    const result = await changeMember(auth.tenant, auth.userId, userId, change);
    return result.ok ? ok({ member: result.member, changed: result.changed }) : memberFailure(result.reason);
  }),
  { tenant: true, roles: ["ADMIN"] },
);
