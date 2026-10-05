import type { NextRequest } from "next/server";
import type { Role } from "@prisma/client";
import { fail, noStore } from "@/lib/api/envelope";
import { validateCSRF } from "@/lib/auth/csrf";
import { getSessionFromRequest, type ResolvedSession } from "@/lib/auth/session";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { resolveTenant, type TenantContext } from "@/lib/tenant/resolve-tenant";

// The shared route guard (same name and call shape as AlEemaan's, replacing its requireAdmin()). Authorization
// stays in route handlers, never in Next.js middleware — CVE-2025-29927 was a critical middleware-bypass, and
// this design already put every check in handlers; it's now a stated rule (docs/auth-review-2026-09-29.md
// finding 16).
//
//   withAuth(handler)                                   — a signed-in person, nothing tenant-specific
//   withAuth(handler, { tenant: true })                 — + the URL's school, VERIFIED against the person's own
//                                                         membership (resolve-tenant.ts), with a tenant-scoped
//                                                         database handle
//   withAuth(handler, { tenant: true, roles: [...] })   — + the role they hold IN THAT SCHOOL is in the list
//
// `roles` is only legal with `tenant: true` (a type error otherwise, and a throw at construction if the types are
// bypassed): a role only means something against a specific, verified tenant's membership, and "any membership
// anywhere has this role" would let an ADMIN of school A through on school B's routes — a cross-tenant privilege
// escalation. `permissions` stays unavailable until the lightweight permission set arrives (§1.7).

export type AuthContext = ResolvedSession;

/// What a tenant route receives: the session, plus the school it was verified against.
export type TenantAuthContext = AuthContext & {
  tenant: TenantContext & {
    /// Runs `fn` in ONE transaction with the tenant context set — the only door to tenant-scoped data. The id it
    /// uses is the verified one; there is no parameter to get wrong.
    run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  };
};

/// The Next.js route context of a `/…/[code]/…` route.
export type TenantRouteContext = { params: Promise<{ code: string }> };

export type PlainOptions = { tenant?: false; roles?: never; permissions?: never };
export type TenantOptions = { tenant: true; roles?: readonly Role[]; permissions?: never };
export type WithAuthOptions = PlainOptions | TenantOptions;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/// One body for "no such school", "not a member" and "your role isn't allowed here" — see resolve-tenant.ts.
const NO_ACCESS = "You don't have access to this school.";

export function withAuth<C = unknown>(
  handler: (req: NextRequest, auth: AuthContext, routeContext: C) => Promise<Response> | Response,
  options?: PlainOptions,
): (req: NextRequest, routeContext: C) => Promise<Response>;
export function withAuth<C extends TenantRouteContext>(
  handler: (req: NextRequest, auth: TenantAuthContext, routeContext: C) => Promise<Response> | Response,
  options: TenantOptions,
): (req: NextRequest, routeContext: C) => Promise<Response>;
export function withAuth(
  handler: (req: NextRequest, auth: never, routeContext: never) => Promise<Response> | Response,
  options: WithAuthOptions = {},
) {
  if ("permissions" in options) {
    throw new Error(
      "withAuth: `permissions` is not available until the lightweight permission set (§1.7) — " +
        "see domain-implementation-plan.md §0.5.1, divergence #1.",
    );
  }
  if ("roles" in options && options.tenant !== true) {
    throw new Error(
      "withAuth: `roles` needs `tenant: true` — a role only means something against a specific verified school " +
        "(domain-implementation-plan.md §0.5.2).",
    );
  }
  const tenantOptions = options.tenant === true ? options : null;
  if (tenantOptions?.roles !== undefined && !Array.isArray(tenantOptions.roles)) {
    throw new Error("withAuth: `roles` must be an array");
  }

  return async (req: NextRequest, routeContext: unknown): Promise<Response> => {
    // CSRF is enforced HERE for every state-changing method, not left as a per-route opt-in call — one forgotten
    // validateCSRF() in one route is a real gap, and every school shares one origin. The refusals are uncacheable
    // too: every response this wrapper emits is, not only the handler's success path.
    if (!SAFE_METHODS.has(req.method) && !validateCSRF(req)) {
      return noStore(fail("Cross-origin request blocked", 403, "CSRF"));
    }

    const session = await getSessionFromRequest(req);
    if (!session) {
      return noStore(fail("Authentication required", 401, "UNAUTHENTICATED"));
    }

    let auth: AuthContext | TenantAuthContext = session;
    if (tenantOptions) {
      // The URL's `[code]` is a lookup key and nothing more; the membership decides.
      const params = await (routeContext as TenantRouteContext | undefined)?.params;
      const resolved = await resolveTenant({ userId: session.userId, code: params?.code ?? "" });
      if (!resolved.ok) {
        return noStore(
          resolved.status === 500
            ? fail("This installation is misconfigured. Contact your administrator.", 500, resolved.code)
            : fail(NO_ACCESS, 403, resolved.code),
        );
      }
      const { tenant } = resolved;
      // `.some()`-style on purpose: if a person can ever hold several roles in a school this keeps working, where
      // `.includes(role)` against a value that became an array would silently never match.
      if (tenantOptions.roles && ![tenant.role].some((held) => tenantOptions.roles!.includes(held))) {
        return noStore(fail(NO_ACCESS, 403, "FORBIDDEN"));
      }
      auth = { ...session, tenant: { ...tenant, run: (fn) => forTenant(tenant.tenantId).transaction(fn) } };
    }

    const response = await handler(req, auth as never, routeContext as never);
    // Responses to an authenticated request are user-specific: never cache.
    try {
      if (!response.headers.has("Cache-Control")) {
        response.headers.set("Cache-Control", "private, no-store");
      }
    } catch {
      // Immutable headers (e.g. Response.redirect) — handlers should return a NextResponse.
    }
    return response;
  };
}
