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

// @ts-expect-error `permissions` is not available until §1.7
withAuth(handler, { permissions: ["students:read"] });

// @ts-expect-error `permissions` is not available with a tenant either
withAuth(handler, { tenant: true, permissions: ["students:read"] });

// A tenant route's handler receives `auth.tenant`, and only a real Role is accepted.
withAuth(async (_req: NextRequest, auth: TenantAuthContext, ctx: TenantRouteContext) => {
  void ctx;
  void auth.tenant.tenantId;
  void auth.tenant.role;
  return new Response("ok");
}, { tenant: true, roles: ["ADMIN", "TEACHING_STAFF"] });

// @ts-expect-error not a Role
withAuth(async () => new Response("ok"), { tenant: true, roles: ["SUPERUSER"] });

// A tenant route must be able to read `[code]`: a route context without it is refused.
// @ts-expect-error the route context has no `params.code`
withAuth(async (_req: NextRequest, auth: TenantAuthContext, ctx: { nothing: true }) => (void auth, void ctx, new Response("ok")), { tenant: true });

// The branded id: a plain string — a URL segment, say — is not a VerifiedTenantId.
const fromUrl: string = "tenant-from-the-url";
// @ts-expect-error a raw string is not verified
forTenant(fromUrl);
// @ts-expect-error a raw string cannot be assigned to the brand either
const unchecked: VerifiedTenantId = fromUrl;
void unchecked;
forTenant(trustedTenantId("t_1")); // the one sanctioned constructor
