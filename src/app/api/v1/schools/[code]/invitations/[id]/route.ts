import { ok } from "@/lib/api/envelope";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { isPlausibleId, notFound } from "@/lib/members/http";
import { revokeInvitation } from "@/lib/invitations/service";

// DELETE /api/v1/schools/[code]/invitations/[id]                                           (plan §0.5.4)
// Revokes an OPEN invitation — ADMIN only, audited. An accepted, already-revoked, unknown or another school's id is the same
// 404: "no such open invitation".
type Ctx = { params: Promise<{ code: string; id: string }> };

export const DELETE = withAuth(
  async (_req, auth: TenantAuthContext, ctx: Ctx) => {
    const { id } = await ctx.params;
    if (!isPlausibleId(id)) return notFound("open invitation");
    return (await revokeInvitation(auth.tenant, auth.userId, id)) ? ok({ revoked: true }) : notFound("open invitation");
  },
  { tenant: true, roles: ["ADMIN"] },
);
