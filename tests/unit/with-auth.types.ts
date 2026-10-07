// Compile-time checks, enforced by `pnpm typecheck` (tsc) — not runtime tests. If a line below that is meant
// to be an error ever compiles, tsc reports "Unused '@ts-expect-error' directive", which is the point.
import type { NextRequest } from "next/server";
import { withAuth, type TenantAuthContext, type TenantRouteContext } from "@/lib/auth/with-auth";
import { forTenant } from "@/lib/tenant/for-tenant";
import { trustedTenantId, type VerifiedTenantId } from "@/lib/tenant/verified-tenant";

const handler = async () => new Response("ok");

withAuth(handler); // the plain call shape still compiles
withAuth(handler, {}); // …and so does an empty options object

// `roles` means nothing without a verified school: it needs `tenant: true`.
// @ts-expect-error `roles` without `tenant: true`
withAuth(handler, { roles: ["ADMIN"] });

// @ts-expect-error `roles` with `tenant: false`
withAuth(handler, { tenant: false, roles: ["ADMIN"] });

// `permissions`, like `roles`, needs a verified school.
// @ts-expect-error `permissions` without `tenant: true`
withAuth(handler, { permissions: ["CAN_MANAGE_FINANCE"] });

// @ts-expect-error `permissions` with `tenant: false`
withAuth(handler, { tenant: false, permissions: ["CAN_MANAGE_FINANCE"] });

// A real permission is accepted — alone, or together with roles (role OR permission).
withAuth(
  async (_req: NextRequest, auth: TenantAuthContext, ctx: TenantRouteContext) => (
    void auth.tenant.permissions,
    void ctx,
    new Response("ok")
  ),
  {
    tenant: true,
    permissions: ["CAN_MANAGE_FINANCE"],
  },
);
withAuth(async (_req: NextRequest, auth: TenantAuthContext, ctx: TenantRouteContext) => (void auth, void ctx, new Response("ok")), {
  tenant: true,
  roles: ["TEACHING_STAFF"],
  permissions: ["CAN_APPROVE_RESULTS", "CAN_PUBLISH_CONTENT"],
});

// @ts-expect-error not a Permission (a typo would otherwise never match)
withAuth(async () => new Response("ok"), { tenant: true, permissions: ["CAN_MANAGE_FINANCES"] });

// @ts-expect-error the old placeholder names are gone
withAuth(async () => new Response("ok"), { tenant: true, permissions: ["students:read"] });

// A tenant route's handler receives `auth.tenant`, and only a real Role is accepted.
withAuth(
  async (_req: NextRequest, auth: TenantAuthContext, ctx: TenantRouteContext) => {
    void ctx;
    void auth.tenant.tenantId;
    void auth.tenant.role;
    return new Response("ok");
  },
  { tenant: true, roles: ["ADMIN", "TEACHING_STAFF"] },
);

// @ts-expect-error not a Role
withAuth(async () => new Response("ok"), { tenant: true, roles: ["SUPERUSER"] });

// A tenant route must be able to read `[code]`: a route context without it is refused.
// @ts-expect-error the route context has no `params.code`
withAuth(async (_req: NextRequest, auth: TenantAuthContext, ctx: { nothing: true }) => (void auth, void ctx, new Response("ok")), {
  tenant: true,
});

// The branded id: a plain string — a URL segment, say — is not a VerifiedTenantId.
const fromUrl: string = "tenant-from-the-url";
// @ts-expect-error a raw string is not verified
forTenant(fromUrl);
// @ts-expect-error a raw string cannot be assigned to the brand either
const unchecked: VerifiedTenantId = fromUrl;
void unchecked;
forTenant(trustedTenantId("t_1")); // the one sanctioned constructor
