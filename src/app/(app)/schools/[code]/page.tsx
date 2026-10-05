import type { Metadata } from "next";
import { GraduationCapIcon } from "@/components/ui/icons";
import { ROLE_LABELS } from "@/lib/roles";
import { requireTenantPage } from "@/lib/tenant/page-tenant";

export const metadata: Metadata = { title: "Your school" };
export const dynamic = "force-dynamic";

// A school's workspace (domain-implementation-plan.md §0.5.2). Deliberately small: Phase 1 grows it into the real
// dashboard. What it already does is the whole trust boundary end to end — the URL's code is resolved and the
// signed-in person's OWN membership verified (403 otherwise), and the campuses below are read through the tenant
// context, so the page is itself a live check that the right school's rows come back.
export default async function SchoolPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const { session, tenant } = await requireTenantPage(code);
  const displayName = session.user.name?.trim() || session.user.email || "there";
  const firstName = displayName.split(/\s+/)[0];

  const campuses = await tenant.run((tx) =>
    tx.campus.findMany({
      where: {
        tenantId: tenant.tenantId,
        ...(tenant.role === "ADMIN" ? {} : { id: tenant.campusId ?? "none" }),
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  );

  return (
    <div>
        <h1 className="text-3xl font-bold tracking-tight text-fg">Welcome, {firstName}</h1>
        <div className="mt-8 flex items-start gap-4">
          <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand-fg">
            <GraduationCapIcon className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight break-words text-fg">{tenant.tenantName}</h2>
            <p className="mt-1 text-base text-fg-muted">
              You&apos;re signed in as <strong className="font-semibold text-fg">{ROLE_LABELS[tenant.role]}</strong>
              {tenant.role === "ADMIN" ? " · all campuses" : ""}.
            </p>
            <p className="mt-1 font-mono text-xs text-fg-muted">{tenant.tenantCode}</p>
          </div>
        </div>

        <section aria-labelledby="campuses-heading" className="mt-10">
          <h3 id="campuses-heading" className="text-sm font-semibold tracking-wider text-fg-muted uppercase">
            {tenant.role === "ADMIN" ? "Campuses" : "Your campus"}
          </h3>
          {campuses.length === 0 ? (
            <p className="mt-4 rounded-2xl border border-dashed border-line-strong p-8 text-center text-sm text-fg-muted">
              {tenant.role === "ADMIN" ? "No campuses have been added yet." : "You haven’t been assigned to a campus yet."}
            </p>
          ) : (
            <ul className="mt-4 grid gap-4 sm:grid-cols-2">
              {campuses.map((c) => (
                <li key={c.id} className="rounded-2xl border border-line bg-surface p-5 font-semibold text-fg">
                  {c.name}
                </li>
              ))}
            </ul>
          )}
        </section>
    </div>
  );
}
