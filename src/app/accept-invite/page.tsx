import type { Metadata } from "next";
import { AcceptInviteForm } from "@/components/auth/AcceptInviteForm";
import { AuthShell } from "@/components/auth/AuthShell";

// `referrer: no-referrer` — the link that opens this page carries a secret (the form removes it from the address bar at once), so nothing
// this page links to or loads may ever see it as a Referer.
export const metadata: Metadata = { title: "Join your school", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default function AcceptInvitePage() {
  return (
    <AuthShell>
      <AcceptInviteForm />
      <noscript>
        <p className="mt-4 text-sm text-fg-muted">This page needs JavaScript to read your invitation link.</p>
      </noscript>
    </AuthShell>
  );
}
