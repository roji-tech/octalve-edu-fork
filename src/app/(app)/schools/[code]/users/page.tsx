import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { UsersPanel } from "@/components/users/UsersPanel";
import { requireTenantPage } from "@/lib/tenant/page-tenant";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

// The school's people and invitations (plan §0.5.4) — administrators only. The page resolves the school from the person's OWN membership
// (403 otherwise) and then requires the ADMIN role IN THAT SCHOOL: anyone else gets the same 403 view as a stranger, so the page does not
// say a role was the problem. The list itself comes from the members API, which enforces the same rule again.
export default async function UsersPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const { session, tenant } = await requireTenantPage(code);
  if (tenant.role !== "ADMIN") forbidden();

  const campuses = await tenant.run((tx) => tx.campus.findMany({ where: { tenantId: tenant.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }));

  return (
    <div>
      <PageHeader title="Users" description={`The people who can sign in to ${tenant.tenantName}, and the invitations still waiting for an answer.`} />
      <UsersPanel schoolCode={tenant.tenantCode} schoolName={tenant.tenantName} campuses={campuses} currentUserId={session.userId} />
    </div>
  );
}
