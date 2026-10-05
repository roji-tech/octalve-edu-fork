"use client";

import { Button } from "@/components/ui/Button";
import { MailIcon } from "@/components/ui/icons";
import { ROLE_LABELS } from "@/lib/roles";
import { expiryText, type Invitation } from "./model";

/// The school's OPEN invitations: who was invited, as what, by whom, and how long the link has left. Resend gives a fresh link (the old one
/// stops working); Revoke ends it. Each button names the address, so a screen-reader user hears which row they are on.
export function InvitationsList({
  invitations,
  busyId,
  onResend,
  onRevoke,
}: {
  invitations: Invitation[];
  busyId: string | null;
  onResend: (invitation: Invitation) => void;
  onRevoke: (invitation: Invitation) => void;
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {invitations.map((invitation) => {
        const expired = invitation.status === "expired";
        const busy = busyId === invitation.id;
        return (
          <li key={invitation.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-muted">
                <MailIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold break-words text-fg">{invitation.email}</p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {ROLE_LABELS[invitation.role]}
                  {invitation.campusName ? ` · ${invitation.campusName}` : ""}
                  {invitation.invitedByName ? ` · invited by ${invitation.invitedByName}` : ""}
                </p>
                <p className={`mt-0.5 text-xs font-medium ${expired ? "text-danger-text" : "text-fg-muted"}`}>{expiryText(invitation.expiresAt)}</p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="secondary" className="flex-1 sm:flex-none" loading={busy} disabled={busyId !== null && !busy} onClick={() => onResend(invitation)} aria-label={`Resend the invitation to ${invitation.email}`}>
                {expired ? "Send again" : "Resend"}
              </Button>
              <Button variant="ghost" className="flex-1 sm:flex-none" disabled={busyId !== null} onClick={() => onRevoke(invitation)} aria-label={`Revoke the invitation to ${invitation.email}`}>
                Revoke
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
