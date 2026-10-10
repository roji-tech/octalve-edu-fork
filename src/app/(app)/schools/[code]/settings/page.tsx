import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { SchoolSettingsPanel } from "@/components/settings/SchoolSettingsPanel";
import { requireTenantPage } from "@/lib/tenant/page-tenant";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

// School settings and configurability panel (PRD §14, plan §1.3, roadmap §1.7) — administrators only.
// Requires step-up re-authentication on every write and maintains an immutable audit ledger.
export default async function SettingsPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const { tenant } = await requireTenantPage(code);
  if (tenant.role !== "ADMIN") forbidden();

  return (
    <div>
      <PageHeader
        title="Settings"
        description={`Configure academic workflows, billing policies, and security controls for ${tenant.tenantName}.`}
      />
      <SchoolSettingsPanel schoolCode={tenant.tenantCode} />
    </div>
  );
}
