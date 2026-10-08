import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { StaffDetail } from "@/components/people/StaffDetail";
import { fullName } from "@/components/people/model";
import { requireTenantPage } from "@/lib/tenant/page-tenant";
import { isPlausibleId } from "@/lib/people/http";
import { getStaff } from "@/lib/people/staff";

export const metadata: Metadata = { title: "Staff member" };
export const dynamic = "force-dynamic";

// One member of staff (plan "Build design — Phase 1.2", decision P9). Same rule as the People page; an unknown, foreign or other-campus record is one 404 page.
export default async function StaffPage({ params }: { params: Promise<{ code: string; id: string }> }) {
  const { code, id } = await params;
  const { tenant } = await requireTenantPage(code);
  if (tenant.role !== "ADMIN" && tenant.role !== "TEACHING_STAFF" && tenant.role !== "NON_TEACHING_STAFF") forbidden();
  if (!isPlausibleId(id)) notFound();
  const found = await getStaff(tenant, id);
  if (!found.ok) notFound();

  const campuses = await tenant.run((tx) =>
    tx.campus.findMany({ where: { tenantId: tenant.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  );
  return (
    <div>
      <PageHeader title="Staff member" description={`${fullName(found.staff)} at ${tenant.tenantName}.`} />
      <div className="mt-6">
        <StaffDetail
          schoolCode={tenant.tenantCode}
          staffId={id}
          campuses={campuses}
          canEdit={tenant.role === "ADMIN"}
          fallbackName={fullName(found.staff)}
        />
      </div>
    </div>
  );
}
