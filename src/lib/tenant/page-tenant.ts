import { forbidden } from "next/navigation";
import { requirePageSession } from "@/lib/auth/page-session";
import type { ResolvedSession } from "@/lib/auth/session";
import { forTenant, type Tx } from "@/lib/tenant/for-tenant";
import { resolveTenant, type TenantContext } from "@/lib/tenant/resolve-tenant";

/// The page-side twin of `withAuth(…, { tenant: true, roles })` (plan §0.5.2): resolves `/schools/[code]/…` for
/// the signed-in person, verifying THEIR membership — never trusting the URL — and returns the tenant context with
/// a tenant-scoped `run`. Not signed in → sign-in. No such school, or not a member of it →
/// the 403 view (`app/(app)/forbidden.tsx`), one answer for both. Authorization lives here, in the page's own
/// server code, never in `proxy`.
export async function requireTenantPage(code: string): Promise<{
  session: ResolvedSession;
  tenant: TenantContext & { run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };
}> {
  const { session } = await requirePageSession();

  const resolved = await resolveTenant({ userId: session.userId, code });
  if (!resolved.ok) {
    if (resolved.status === 500) throw new Error("Tenant misconfigured — the cause is in the server log (TENANT_MISCONFIGURED)");
    forbidden();
  }
  const { tenant } = resolved;

  return { session, tenant: { ...tenant, run: (fn) => forTenant(tenant.tenantId).transaction(fn) } };
}
