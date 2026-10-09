import { after } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { offsetMeta, parseOffsetPagination } from "@/lib/api/pagination";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { mailInvitation } from "@/lib/invitations/deliver";
import { createInvitation, listOpenInvitations } from "@/lib/invitations/service";
import { campusIdField, emailField, roleField } from "@/lib/members/http";

// /api/v1/schools/[code]/invitations                                                       (plan §0.5.4)
//   GET   the school's open invitations (pending, and expired ones that can be resent) — never a token or its hash
//   POST  invite an address — ADMIN only; a hashed, single-use, seven-day link is emailed AFTER the response
// The answer is the same whether or not the address has an account anywhere on the platform: the administrator learns only
// about THIS school (already a member / deactivated here), never who is registered elsewhere.
const CREATES_PER_WINDOW = 30; // per administrator per school per 5 minutes
const PER_ADDRESS = 3; // per school per address per 5 minutes: you can resend, not hammer

const body = z.strictObject({ email: emailField, role: roleField, campusId: campusIdField.nullable().optional() });

export const GET = withAuth(
  async (req, auth: TenantAuthContext) => {
    const page = parseOffsetPagination(req.nextUrl.searchParams);
    if (!page.ok)
      return fail(
        "Some of the query parameters are not valid.",
        400,
        "VALIDATION",
        page.issues.map((i) => ({ ...i, path: `query.${i.path}` })),
      );
    const { invitations, total } = await listOpenInvitations(auth.tenant, page);
    return ok({ invitations }, offsetMeta({ page: page.page, limit: page.limit, total }));
  },
  { tenant: true, roles: ["ADMIN"] },
);

export const POST = withAuth(
  validate({ body }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body: input }) => {
    const { tenant } = auth;
    if (!(await reserveAttempt(`invite:create:${tenant.tenantId}:${auth.userId}`, CREATES_PER_WINDOW))) {
      return fail("Too many invitations. Please try again in a few minutes.", 429, "RATE_LIMITED");
    }
    if (!(await reserveAttempt(`invite:to:${tenant.tenantId}:${input.email}`, PER_ADDRESS))) {
      return fail("That address was invited several times just now. Please wait a few minutes.", 429, "RATE_LIMITED");
    }
    const result = await createInvitation(tenant, auth.userId, { email: input.email, role: input.role, campusId: input.campusId ?? null });
    if (!result.ok) {
      switch (result.reason) {
        case "ALREADY_MEMBER":
          return fail("That person is already a member of this school.", 409, "ALREADY_MEMBER", [
            { path: "body.email", message: "That person is already a member of this school." },
          ]);
        case "DEACTIVATED_MEMBER":
          return fail("That person was deactivated in this school. Reactivate them instead.", 409, "DEACTIVATED_MEMBER", [
            { path: "body.email", message: "Deactivated here — reactivate them instead." },
          ]);
        case "INVALID_CAMPUS":
          return fail("Choose one of this school's campuses.", 400, "VALIDATION", [
            { path: "body.campusId", message: "Choose one of this school's campuses." },
          ]);
        case "INVALID_STAFF_RECORD":
          // This route never names a staff record (the body is strict); the staff page has its own route for that.
          return fail("That can't be done.", 400, "VALIDATION");
      }
    }

    after(() =>
      mailInvitation({
        to: input.email,
        token: result.token,
        schoolName: tenant.tenantName,
        role: input.role,
        inviterName: auth.user.name,
      }),
    );
    return ok({ invitation: result.invitation }, {}, 201);
  }),
  { tenant: true, roles: ["ADMIN"] },
);
