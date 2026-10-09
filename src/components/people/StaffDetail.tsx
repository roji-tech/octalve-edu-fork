"use client";

import Link from "next/link";
import { useState } from "react";
import { flushSync } from "react-dom";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { ArrowLeftIcon, PlusIcon } from "@/components/ui/icons";
import { sendJson } from "@/components/auth/postJson";
import { FOCUS_RING } from "@/components/shell/nav";
import { ListState, LiveNotice, StatusPill, useDialog, type Notice } from "@/components/academics/parts";
import { failureText, useApi } from "@/components/academics/useApi";
import { ROLE_LABELS } from "@/lib/roles";
import { AccountPill } from "./StaffPanel";
import {
  ArchiveStaffDialog,
  AssignDialog,
  InviteStaffDialog,
  LinkAccountDialog,
  RemoveAssignmentDialog,
  StaffFormDialog,
  UnlinkAccountDialog,
} from "./StaffDialogs";
import { CATEGORY_LABEL, formatDate, fullName, type AssignmentView, type CampusOption, type StaffView } from "./model";

/// One member of staff: their record, whether and how they can sign in, and what they teach. Everyone with access can look; an administrator changes things.
export function StaffDetail({
  schoolCode,
  staffId,
  campuses,
  canEdit,
  fallbackName,
}: {
  schoolCode: string;
  staffId: string;
  campuses: CampusOption[];
  canEdit: boolean;
  fallbackName: string;
}) {
  const root = `/api/v1/schools/${schoolCode}/people/staff/${staffId}`;
  const record = useApi(root);
  const staff = record.reply?.data?.staff as StaffView | undefined;
  const assignments = (record.reply?.data?.assignments as AssignmentView[] | undefined) ?? [];
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const form = useDialog<true>();
  const archiving = useDialog<true>();
  const inviting = useDialog<true>();
  const linking = useDialog<true>();
  const unlinking = useDialog<true>();
  const assigning = useDialog<true>();
  const removing = useDialog<AssignmentView>();

  const done = (close: () => void, text: string) => () => {
    flushSync(close);
    setNotice({ variant: "success", text });
    void record.reload();
  };

  async function restore() {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const reply = await sendJson(`${root}/restore`, "POST");
    setBusy(false);
    if (reply.ok) {
      setNotice({ variant: "success", text: "Restored." });
      void record.reload();
    } else {
      setNotice({ variant: "error", text: failureText(reply.status, reply.message) });
    }
  }

  const name = staff ? fullName(staff) : fallbackName;
  const live = staff ? !staff.archived : false;
  const account = staff?.account;

  return (
    <div className="space-y-6">
      <Link
        href={`/schools/${schoolCode}/people?section=staff`}
        className={`-ml-3 inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-fg-2 hover:bg-surface-2 ${FOCUS_RING}`}
      >
        <ArrowLeftIcon className="h-4 w-4" />
        All staff
      </Link>
      <LiveNotice notice={notice} />

      <ListState
        loading={record.loading}
        error={record.error}
        empty={!staff}
        emptyText="No such member of staff."
        onRetry={() => void record.reload()}
      >
        {staff && account && (
          <>
            <section aria-labelledby="staff-name" className="rounded-2xl border border-line bg-surface p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 id="staff-name" className="text-xl font-semibold tracking-tight break-words text-fg">
                    {name} {staff.archived && <StatusPill tone="neutral">Archived</StatusPill>}
                  </h2>
                  <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-xs text-fg-muted">Kind</dt>
                      <dd className="font-medium text-fg">{CATEGORY_LABEL[staff.category]}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-fg-muted">Campus</dt>
                      <dd className="font-medium text-fg">{staff.campusName ?? "Whole school"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-fg-muted">Phone</dt>
                      <dd className="font-medium break-words text-fg">{staff.phone ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-fg-muted">Email</dt>
                      <dd className="font-medium break-words text-fg">{staff.email ?? "—"}</dd>
                    </div>
                  </dl>
                </div>
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    {live && (
                      <>
                        <Button variant="secondary" aria-label={`Edit ${name}`} onClick={() => (setNotice(null), form.show(true))}>
                          Edit
                        </Button>
                        <Button variant="ghost" aria-label={`Archive ${name}`} onClick={() => (setNotice(null), archiving.show(true))}>
                          Archive
                        </Button>
                      </>
                    )}
                    {staff.archived && (
                      <Button variant="secondary" loading={busy} aria-label={`Restore ${name}`} onClick={() => void restore()}>
                        Restore
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section aria-labelledby="signin-heading" className="space-y-3">
              <h2 id="signin-heading" className="text-lg font-semibold tracking-tight text-fg">
                Sign-in
              </h2>
              <div className="rounded-2xl border border-line bg-surface p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1 text-sm text-fg-2">
                    <p>
                      <AccountPill account={account} />
                    </p>
                    {account.state === "none" && (
                      <p>
                        {staff.email
                          ? `No sign-in yet. An invitation goes to ${staff.email}.`
                          : "No sign-in yet. Add an email address to invite them, or link an existing account."}
                      </p>
                    )}
                    {account.state === "invited" && (
                      <p>
                        An invitation has been sent. It can be resent or withdrawn on the Users page; it ends{" "}
                        {formatDate(account.expiresAt.slice(0, 10))}.
                      </p>
                    )}
                    {account.state === "linked" && (
                      <p>
                        Linked to <strong className="text-fg">{account.name ?? "an unnamed account"}</strong>
                        {account.email ? ` (${account.email})` : ""} · {ROLE_LABELS[account.role]}
                      </p>
                    )}
                  </div>
                  {canEdit && live && (
                    <div className="flex flex-wrap gap-2">
                      {account.state !== "linked" && (
                        <>
                          <Button
                            disabled={!staff.email}
                            aria-label={`Invite ${name} to sign in`}
                            onClick={() => (setNotice(null), inviting.show(true))}
                          >
                            Invite to sign in
                          </Button>
                          <Button
                            variant="secondary"
                            aria-label={`Link ${name} to an existing account`}
                            onClick={() => (setNotice(null), linking.show(true))}
                          >
                            Link account…
                          </Button>
                        </>
                      )}
                      {account.state === "linked" && (
                        <Button
                          variant="ghost"
                          aria-label={`Unlink ${name}'s account`}
                          onClick={() => (setNotice(null), unlinking.show(true))}
                        >
                          Unlink account
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {account.state === "linked" && account.deactivated && (
                  <Alert variant="info" announce={false} className="mt-4">
                    This person&apos;s access was switched off on the Users page, so they can&apos;t sign in.
                  </Alert>
                )}
                {account.state === "linked" && account.roleDiffers && (
                  <Alert variant="info" announce={false} className="mt-4">
                    Their account&apos;s role ({ROLE_LABELS[account.role]}) no longer matches this record&apos;s kind (
                    {CATEGORY_LABEL[staff.category].toLowerCase()}). The Users page changes roles.
                  </Alert>
                )}
              </div>
            </section>

            <section aria-labelledby="teaches-heading" className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 id="teaches-heading" className="text-lg font-semibold tracking-tight text-fg">
                    Teaches
                  </h2>
                  <p className="mt-1 text-sm text-fg-muted">The subjects they teach, and to which classes.</p>
                </div>
                {canEdit && live && (
                  <Button onClick={() => (setNotice(null), assigning.show(true))}>
                    <PlusIcon className="h-4 w-4" />
                    Add a subject
                  </Button>
                )}
              </div>
              {assignments.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-line-strong p-6 text-center text-sm text-fg-muted">
                  Nothing assigned yet.
                </p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                  {assignments.map((assignment) => (
                    <li key={assignment.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-fg">
                        <span className="font-semibold">{assignment.subjectName}</span> · {assignment.classGroupName} {assignment.armName}
                      </p>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          aria-label={`Remove ${assignment.subjectName} in ${assignment.classGroupName} ${assignment.armName}`}
                          onClick={() => (setNotice(null), removing.show(assignment))}
                        >
                          Remove
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {form.n > 0 && (
              <StaffFormDialog
                key={`form-${form.n}`}
                open={form.open}
                onClose={form.hide}
                schoolCode={schoolCode}
                campuses={campuses}
                staff={staff}
                onDone={done(form.hide, "Saved.")}
              />
            )}
            {archiving.n > 0 && (
              <ArchiveStaffDialog
                key={`archiving-${archiving.n}`}
                open={archiving.open}
                onClose={archiving.hide}
                schoolCode={schoolCode}
                staff={staff}
                onDone={done(archiving.hide, "Archived.")}
              />
            )}
            {inviting.n > 0 && (
              <InviteStaffDialog
                key={`inviting-${inviting.n}`}
                open={inviting.open}
                onClose={inviting.hide}
                schoolCode={schoolCode}
                staff={staff}
                onDone={done(inviting.hide, `Invitation sent to ${staff.email}.`)}
              />
            )}
            {linking.n > 0 && (
              <LinkAccountDialog
                key={`linking-${linking.n}`}
                open={linking.open}
                onClose={linking.hide}
                schoolCode={schoolCode}
                staff={staff}
                onDone={done(linking.hide, "Account linked.")}
              />
            )}
            {unlinking.n > 0 && (
              <UnlinkAccountDialog
                key={`unlinking-${unlinking.n}`}
                open={unlinking.open}
                onClose={unlinking.hide}
                schoolCode={schoolCode}
                staff={staff}
                onDone={done(unlinking.hide, "Account unlinked.")}
              />
            )}
            {assigning.n > 0 && (
              <AssignDialog
                key={`assigning-${assigning.n}`}
                open={assigning.open}
                onClose={assigning.hide}
                schoolCode={schoolCode}
                staff={staff}
                onDone={done(assigning.hide, "Added.")}
              />
            )}
            {removing.n > 0 && removing.value && (
              <RemoveAssignmentDialog
                key={`removing-${removing.n}`}
                open={removing.open}
                onClose={removing.hide}
                schoolCode={schoolCode}
                staff={staff}
                assignment={removing.value}
                onDone={done(removing.hide, "Removed.")}
              />
            )}
          </>
        )}
      </ListState>
    </div>
  );
}
