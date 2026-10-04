import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getUserMemberships } from "@/lib/auth/memberships";
import { ROLE_LABELS } from "@/lib/roles";
import { AppHeader } from "@/components/auth/AppHeader";
import { SessionRevalidator } from "@/components/auth/SessionRevalidator";
import { Alert } from "@/components/ui/Alert";
import { GraduationCapIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

// The front door (PRD §7): after sign-in a user lands here. §0.5.2 turns it
// into the router — one school redirects straight into /schools/[code]/…,
// several show a picker. Until that exists it shows, honestly, who is signed
// in and which schools they belong to.
export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const memberships = await getUserMemberships(session.userId);
  const displayName = session.user.name?.trim() || session.user.email || "there";
  const firstName = displayName.split(/\s+/)[0];

  return (
    <div className="min-h-screen bg-canvas text-fg-2">
      <SessionRevalidator />
      <AppHeader name={session.user.name} email={session.user.email} />

      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="text-3xl font-bold tracking-tight text-fg">Welcome, {firstName}</h1>
        <p className="mt-2 text-base text-fg-muted">
          {memberships.length > 0
            ? "Here are the schools you belong to."
            : "You're signed in, but you aren't a member of any school yet."}
        </p>

        <Alert variant="info" title="Your school workspace is on its way" className="mt-8">
          Once it&apos;s ready, this page will take you straight into your school.
        </Alert>

        <section aria-labelledby="schools-heading" className="mt-10">
          <h2
            id="schools-heading"
            className="text-sm font-semibold tracking-wider text-fg-muted uppercase"
          >
            Your schools
          </h2>

          {memberships.length === 0 ? (
            <p className="mt-4 rounded-2xl border border-dashed border-line-strong p-8 text-center text-sm text-fg-muted">
              Ask your school administrator to invite you.
            </p>
          ) : (
            <ul className="mt-4 grid gap-4 sm:grid-cols-2">
              {memberships.map((m) => (
                <li
                  key={`${m.tenantId}`}
                  className="flex items-start gap-4 rounded-2xl border border-line bg-surface p-5"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand-fg"
                  >
                    <GraduationCapIcon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-fg">{m.tenantName}</p>
                    <p className="mt-0.5 text-sm text-fg-muted">
                      {ROLE_LABELS[m.role]}
                      {m.campusName ? ` · ${m.campusName}` : ""}
                    </p>
                    <p className="mt-2 font-mono text-xs text-fg-muted">{m.tenantCode}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
