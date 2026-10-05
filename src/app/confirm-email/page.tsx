import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { ConfirmEmailForm } from "@/components/auth/ConfirmEmailForm";

// `referrer: no-referrer` — the link that opens this page carries a secret (the form removes it from the address
// bar at once), so nothing this page links to or loads may ever see it as a Referer.
export const metadata: Metadata = { title: "Confirm your email address", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default function ConfirmEmailPage() {
  return (
    <AuthShell>
      <ConfirmEmailForm />
      <noscript>
        <p className="mt-4 text-sm text-fg-muted">This page needs JavaScript to read your confirmation link.</p>
      </noscript>
    </AuthShell>
  );
}
