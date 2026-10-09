import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { SectionNav } from "@/components/people/SectionNav";
import { StaffPanel } from "@/components/people/StaffPanel";
import { StudentsPanel } from "@/components/people/StudentsPanel";
import { isSection } from "@/components/people/model";
import { requireTenantPage } from "@/lib/tenant/page-tenant";

export const metadata: Metadata = { title: "People" };
export const dynamic = "force-dynamic";

// People (plan "Build design — Phase 1.2", decision P9): the school's students and its staff. Administrators add, change, import and export; staff may LOOK
// (the same lists, no controls that write; a non-admin sees the school-wide records and their own campus's); students and parents get the one access-denied
// view. Like the other school pages it resolves the school from the person's OWN membership (403 otherwise); the lists and every change go through the
// people API, which enforces the same rules again — hiding a button is a courtesy, not the guard.
export default async function PeoplePage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ section?: string | string[] }>;
}) {
  const { code } = await params;
  const { section: asked } = await searchParams;
  const { tenant } = await requireTenantPage(code);
  if (tenant.role !== "ADMIN" && tenant.role !== "TEACHING_STAFF" && tenant.role !== "NON_TEACHING_STAFF") forbidden();
  const canEdit = tenant.role === "ADMIN";

  const section = isSection(asked) ? asked : "students";
  const campuses = await tenant.run((tx) =>
    tx.campus.findMany({ where: { tenantId: tenant.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  );

  return (
    <div>
      <PageHeader
        title="People"
        description={`The students and staff of ${tenant.tenantName}. Nobody here is ever deleted — people who leave are archived.`}
      />
      <SectionNav schoolCode={tenant.tenantCode} current={section} />
      <div className="mt-8">
        {section === "students" && <StudentsPanel schoolCode={tenant.tenantCode} campuses={campuses} canEdit={canEdit} />}
        {section === "staff" && <StaffPanel schoolCode={tenant.tenantCode} campuses={campuses} canEdit={canEdit} />}
      </div>
    </div>
  );
}
