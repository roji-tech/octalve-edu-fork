import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { requirePageSession } from "@/lib/auth/page-session";

/// Every signed-in page lives in this route group and so inside the shell. The layout only DISPLAYS who is signed in and
/// which schools they belong to — a layout isn't re-rendered when someone navigates between the pages it wraps, so each
/// page calls `requirePageSession()` (or `requireTenantPage`) itself; the call is cached per request, so that costs nothing
/// extra. What the shell shows is never what decides access.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { session, memberships } = await requirePageSession();

  return (
    <AppShell
      user={{ name: session.user.name, email: session.user.email }}
      schools={memberships.map((m) => ({ code: m.tenantCode, name: m.tenantName, role: m.role }))}
    >
      {children}
    </AppShell>
  );
}
