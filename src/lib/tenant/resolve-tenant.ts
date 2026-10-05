import type { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertRlsEnforced } from "@/lib/tenant/assert-rls";
import { forUser } from "@/lib/tenant/for-tenant";
import { isValidTenantCode } from "@/lib/tenant/validate-code";
import { trustedTenantId, type VerifiedTenantId } from "@/lib/tenant/verified-tenant";

// The tenant trust boundary (domain-implementation-plan.md §0.5.2, "`resolveTenant`"). The URL's `[code]` segment
// is a LOOKUP KEY, never a claim: it is resolved to a tenant, and the caller's own membership in that tenant is
// then looked up. No membership → refused, whatever the URL says. This is the only place a request becomes a
// `VerifiedTenantId`.

export type TenantContext = {
  tenantId: VerifiedTenantId;
  tenantCode: string;
  tenantName: string;
  /// The caller's role IN THIS TENANT — never "any role anywhere".
  role: Role;
  /// The campus the membership is anchored to. An ADMIN is tenant-wide whatever this is (it is bookkeeping for an
  /// admin — AlEemaan's branch rule, kept identical on purpose); other roles are scoped to it.
  campusId: string | null;
};

export type ResolveResult =
  | { ok: true; tenant: TenantContext }
  /// 403: no such school, a malformed code, or the caller is not a member — deliberately ONE answer, so the response
  /// cannot be used to find out which schools exist.
  /// 500: the installation cannot be trusted to isolate schools — `DEPLOYMENT_MODE=solo` but the database does not hold
  /// exactly one tenant, or the database role does not really enforce row-level security — fail closed. The cause goes to
  /// the log; the caller only learns that the installation is misconfigured.
  | { ok: false; status: 403 | 500; code: "FORBIDDEN" | "TENANT_MISCONFIGURED" };

const FORBIDDEN: ResolveResult = { ok: false, status: 403, code: "FORBIDDEN" };

/// `DEPLOYMENT_MODE=solo` only changes WHERE the tenant comes from (the install's one row), never whether the
/// membership is verified. If that variable were wrong on a SaaS deployment — or a second tenant appeared in a Solo
/// install — "the first tenant row" would become "every signed-in person gets school one"; so the invariant that
/// exactly one tenant exists is asserted on every resolution, and a violation is a 500, not a guess.
async function soloTenant(): Promise<{ id: string; code: string; name: string } | "misconfigured"> {
  const rows = await prisma.tenant.findMany({ take: 2, select: { id: true, code: true, name: true } });
  if (rows.length !== 1) {
    console.error(`[TENANT_MISCONFIGURED] DEPLOYMENT_MODE=solo but the database holds ${rows.length === 0 ? "no" : "more than one"} tenant`);
    return "misconfigured";
  }
  return rows[0];
}

export async function resolveTenant(input: { userId: string; code: string }): Promise<ResolveResult> {
  const code = typeof input.code === "string" ? input.code.trim().toLowerCase() : "";
  if (!isValidTenantCode(code)) return FORBIDDEN;

  // The database role must really be subject to row-level security (checked once per process) — before any tenant
  // data is looked up. Garbage codes above never reach it: refusing them says nothing about the install.
  try {
    await assertRlsEnforced();
  } catch (error) {
    console.error(`[TENANT_MISCONFIGURED] ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, status: 500, code: "TENANT_MISCONFIGURED" };
  }

  // Which tenant the membership is looked up in: the one the URL's code names (SaaS) — or, in Solo, the install's
  // single tenant BY ID, with the URL's code only checked against it. (Looking up by the URL's code in both modes
  // would make the Solo code check redundant; the whole point of Solo is that the tenant does NOT come from the URL.)
  let tenantFilter: { code: string } | { id: string } = { code };
  if (process.env.DEPLOYMENT_MODE === "solo") {
    const only = await soloTenant();
    if (only === "misconfigured") return { ok: false, status: 500, code: "TENANT_MISCONFIGURED" };
    if (only.code !== code) return FORBIDDEN;
    tenantFilter = { id: only.id };
  }

  // The caller's membership in the tenant with this code, read through the user context (the one path by which a
  // person may see their own memberships before any tenant is known). Tenant is not tenant-scoped data.
  const membership = await forUser(input.userId).transaction((tx) =>
    tx.tenantMembership.findFirst({
      // A deactivated membership is no membership: the person was removed from this school (the row stays for history).
      where: { userId: input.userId, tenant: tenantFilter, deactivatedAt: null },
      select: { role: true, campusId: true, tenant: { select: { id: true, code: true, name: true } } },
    }),
  );
  if (!membership) return FORBIDDEN;

  return {
    ok: true,
    tenant: {
      tenantId: trustedTenantId(membership.tenant.id), // verified: the caller's own membership row names it
      tenantCode: membership.tenant.code,
      tenantName: membership.tenant.name,
      role: membership.role,
      campusId: membership.campusId,
    },
  };
}
