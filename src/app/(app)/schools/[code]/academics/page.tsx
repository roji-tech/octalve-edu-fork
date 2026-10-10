import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { AssessmentPanel } from "@/components/academics/AssessmentPanel";
import { AttendancePanel } from "@/components/academics/AttendancePanel";
import { ClassesPanel } from "@/components/academics/ClassesPanel";
import { GradingPanel } from "@/components/academics/GradingPanel";
import { SectionNav } from "@/components/academics/SectionNav";
import { SessionsPanel } from "@/components/academics/SessionsPanel";
import { TimetablePanel } from "@/components/academics/TimetablePanel";
import { isSection } from "@/components/academics/model";
import { requireTenantPage } from "@/lib/tenant/page-tenant";

export const metadata: Metadata = { title: "Academic setup" };
export const dynamic = "force-dynamic";

// Academic setup (plan "Build design — Phase 1.0 and 1.1", and 1.2 decision P9): the school year and its terms, the classes and subjects, how marks are built
// and how scores become grades. Administrators change it; staff may LOOK (the same four sections with every control that writes left out); students and
// parents get the one access-denied view. Like the Users page it resolves the school from the person's OWN membership (403 otherwise); the lists and every
// change go through the academics API, which enforces the same rules again — hiding a button is a courtesy, not the guard.
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
  if (tenant.role !== "ADMIN" && tenant.role !== "TEACHING_STAFF" && tenant.role !== "NON_TEACHING_STAFF") forbidden();
  const readOnly = tenant.role !== "ADMIN";

  const section = isSection(asked) ? asked : "timetable";
  const campuses = await tenant.run((tx) =>
    tx.campus.findMany({ where: { tenantId: tenant.tenantId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  );

  return (
    <div>
      <PageHeader
        title="Academic setup"
        description={
          readOnly
            ? `The school year, classes, subjects, timetable and grading for ${tenant.tenantName}. Only an administrator can change this.`
            : `The school year, classes, subjects, timetable and grading for ${tenant.tenantName}. Nothing here is ever deleted — old items are archived.`
        }
      />
      <SectionNav schoolCode={tenant.tenantCode} current={section} />
      <div className="mt-8">
        {section === "timetable" && <TimetablePanel schoolCode={tenant.tenantCode} readOnly={readOnly} />}
        {section === "attendance" && <AttendancePanel schoolCode={tenant.tenantCode} readOnly={readOnly} />}
        {section === "sessions" && (
          <SessionsPanel schoolCode={tenant.tenantCode} campuses={campuses} schoolType={tenant.schoolType} readOnly={readOnly} />
        )}
        {section === "classes" && <ClassesPanel schoolCode={tenant.tenantCode} campuses={campuses} readOnly={readOnly} />}
        {section === "assessment" && <AssessmentPanel schoolCode={tenant.tenantCode} readOnly={readOnly} />}
        {section === "grading" && <GradingPanel schoolCode={tenant.tenantCode} readOnly={readOnly} />}
      </div>
    </div>
  );
}
