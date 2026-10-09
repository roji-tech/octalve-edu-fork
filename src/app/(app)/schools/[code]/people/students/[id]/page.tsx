import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { StudentDetail } from "@/components/people/StudentDetail";
import { fullName } from "@/components/people/model";
import { requireTenantPage } from "@/lib/tenant/page-tenant";
import { isPlausibleId } from "@/lib/people/http";
import { getStudent } from "@/lib/people/students";

export const metadata: Metadata = { title: "Student" };
export const dynamic = "force-dynamic";

// One student (plan "Build design — Phase 1.2", decision P9). Same rule as the People page: administrators and staff; everyone else the one 403 view. A student the
// caller may not see — unknown, another school's, another campus's — is the same 404 page for all three (the read below goes through the caller's campus scope).
export default async function StudentPage({ params }: { params: Promise<{ code: string; id: string }> }) {
  const { code, id } = await params;
  const { tenant } = await requireTenantPage(code);
  if (tenant.role !== "ADMIN" && tenant.role !== "TEACHING_STAFF" && tenant.role !== "NON_TEACHING_STAFF") forbidden();
  if (!isPlausibleId(id)) notFound();
  const found = await getStudent(tenant, id);
  if (!found.ok) notFound();

  const campuses = await tenant.run((tx) =>
    tx.campus.findMany({ where: { tenantId: tenant.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  );
  return (
    <div>
      <PageHeader title="Student" description={`${fullName(found.student)} at ${tenant.tenantName}.`} />
      <div className="mt-6">
        <StudentDetail
          schoolCode={tenant.tenantCode}
          studentId={id}
          campuses={campuses}
          canEdit={tenant.role === "ADMIN"}
          fallbackName={fullName(found.student)}
        />
      </div>
    </div>
  );
}
