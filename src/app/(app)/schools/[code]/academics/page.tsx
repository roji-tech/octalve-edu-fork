import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { AssessmentPanel } from "@/components/academics/AssessmentPanel";
import { ClassesPanel } from "@/components/academics/ClassesPanel";
import { GradingPanel } from "@/components/academics/GradingPanel";
import { SectionNav } from "@/components/academics/SectionNav";
import { SessionsPanel } from "@/components/academics/SessionsPanel";
import { isSection } from "@/components/academics/model";
import { requireTenantPage } from "@/lib/tenant/page-tenant";

export const metadata: Metadata = { title: "Academic setup" };
export const dynamic = "force-dynamic";

// Academic setup (plan "Build design — Phase 1.0 and 1.1"): the school year and its terms, the classes and subjects, how marks are built and how
// scores become grades — administrators only. Like the Users page it resolves the school from the person's OWN membership (403 otherwise), then
// requires ADMIN in that school; the lists and every change go through the academics API, which enforces the same rule again.
export default async function AcademicsPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ section?: string | string[] }>;
}) {
  const { code } = await params;
  const { section: asked } = await searchParams;
  const { tenant } = await requireTenantPage(code);
  if (tenant.role !== "ADMIN") forbidden();

  const section = isSection(asked) ? asked : "sessions";
  const campuses = await tenant.run((tx) =>
    tx.campus.findMany({ where: { tenantId: tenant.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  );

  return (
    <div>
      <PageHeader
        title="Academic setup"
        description={`The school year, classes, subjects and grading for ${tenant.tenantName}. Nothing here is ever deleted — old items are archived.`}
      />
      <SectionNav schoolCode={tenant.tenantCode} current={section} />
      <div className="mt-8">
        {section === "sessions" && <SessionsPanel schoolCode={tenant.tenantCode} campuses={campuses} schoolType={tenant.schoolType} />}
        {section === "classes" && <ClassesPanel schoolCode={tenant.tenantCode} campuses={campuses} />}
        {section === "assessment" && <AssessmentPanel schoolCode={tenant.tenantCode} />}
        {section === "grading" && <GradingPanel schoolCode={tenant.tenantCode} />}
      </div>
    </div>
  );
}
