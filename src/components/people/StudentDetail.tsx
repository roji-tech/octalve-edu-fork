"use client";

import Link from "next/link";
import { useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/Button";
import { ArrowLeftIcon, PlusIcon } from "@/components/ui/icons";
import { sendJson, type Reply } from "@/components/auth/postJson";
import { FOCUS_RING } from "@/components/shell/nav";
import { ConfirmDialog, ListState, LiveNotice, StatusPill, useDialog, type Notice } from "@/components/academics/parts";
import { failureText, useApi } from "@/components/academics/useApi";
import { AddGuardianDialog, EditLinkDialog, RemoveGuardianDialog } from "./GuardianDialogs";
import { ArchiveStudentDialog, EnrolDialog, StudentFormDialog, WithdrawDialog, enrolmentTone } from "./StudentDialogs";
import {
  ENROLMENT_STATUS_LABEL,
  RELATIONSHIP_LABEL,
  formatDate,
  fullName,
  type CampusOption,
  type EnrolmentView,
  type GuardianLinkView,
  type StudentView,
} from "./model";

/// One student: their record, the classes they have been in (one row per session), and their guardians. Everyone with access can look; an administrator changes
/// things. All of it goes through the people API.
export function StudentDetail({
  schoolCode,
  studentId,
  campuses,
  canEdit,
  fallbackName,
}: {
  schoolCode: string;
  studentId: string;
  campuses: CampusOption[];
  canEdit: boolean;
  fallbackName: string;
}) {
  const root = `/api/v1/schools/${schoolCode}/people/students/${studentId}`;
  const record = useApi(root);
  const guardians = useApi(`${root}/guardians`);
  const student = record.reply?.data?.student as StudentView | undefined;
  const enrolments = (record.reply?.data?.enrolments as EnrolmentView[] | undefined) ?? [];
  const links = (guardians.reply?.data?.guardians as GuardianLinkView[] | undefined) ?? [];
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const reloadAll = async () => {
    await Promise.all([record.reload(), guardians.reload()]);
  };
  const form = useDialog<true>();
  const archiving = useDialog<true>();
  const enrolling = useDialog<{ moving: EnrolmentView | null }>();
  const withdrawing = useDialog<EnrolmentView>();
  const addingGuardian = useDialog<true>();
  const editingLink = useDialog<GuardianLinkView>();
  const removing = useDialog<GuardianLinkView>();

  const [duplicateToRestore, setDuplicateToRestore] = useState<string | null>(null);

  const done = (close: () => void, text: string) => () => {
    flushSync(close);
    setNotice({ variant: "success", text });
    void reloadAll();
  };

  async function restore(allowDuplicate = false) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const reply = await sendJson(`${root}/restore`, "POST", allowDuplicate ? { allowDuplicate: true } : undefined);
    setBusy(false);
    if (reply.ok) {
      setDuplicateToRestore(null);
      setNotice({ variant: "success", text: "Restored." });
      void reloadAll();
    } else if (reply.code === "POSSIBLE_DUPLICATE") {
      setDuplicateToRestore(reply.message ?? "A student with the same name and date of birth already exists.");
    } else {
      setNotice({ variant: "error", text: failureText(reply.status, reply.message) });
    }
  }

  const name = student ? fullName(student) : fallbackName;
  const live = student ? !student.archived : false;

  return (
    <div className="space-y-6">
      <Link
        href={`/schools/${schoolCode}/people?section=students`}
        className={`-ml-3 inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-fg-2 hover:bg-surface-2 ${FOCUS_RING}`}
      >
        <ArrowLeftIcon className="h-4 w-4" />
        All students
      </Link>
      <LiveNotice notice={notice} />

      <ListState
        loading={record.loading}
        error={record.error}
        empty={!student}
        emptyText="No such student."
        onRetry={() => void record.reload()}
      >
        {student && (
          <>
            <section aria-labelledby="student-heading" className="rounded-2xl border border-line bg-surface p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 id="student-heading" className="text-xl font-semibold tracking-tight break-words text-fg">
                    {name} {student.archived && <StatusPill tone="neutral">Archived</StatusPill>}
                  </h2>
                  <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-fg-muted">Admission number</dt>
                      <dd className="font-medium text-fg">{student.admissionNo}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-fg-muted">Date of birth</dt>
                      <dd className="font-medium text-fg">{formatDate(student.dateOfBirth)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-fg-muted">Campus</dt>
                      <dd className="font-medium text-fg">{student.campusName ?? "Whole school"}</dd>
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
                    {student.archived && (
                      <Button variant="secondary" loading={busy} aria-label={`Restore ${name}`} onClick={() => void restore()}>
                        Restore
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section aria-labelledby="enrolments-heading" className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 id="enrolments-heading" className="text-lg font-semibold tracking-tight text-fg">
                    Classes
                  </h2>
                  <p className="mt-1 text-sm text-fg-muted">One class for each school year, newest first.</p>
                </div>
                {canEdit && live && (
                  <Button onClick={() => (setNotice(null), enrolling.show({ moving: null }))}>
                    <PlusIcon className="h-4 w-4" />
                    Enrol in a class
                  </Button>
                )}
              </div>
              {enrolments.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-line-strong p-6 text-center text-sm text-fg-muted">
                  Not in a class yet.
                </p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                  {enrolments.map((enrolment) => (
                    <li key={enrolment.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold break-words text-fg">
                          {enrolment.classGroupName} {enrolment.armName}{" "}
                          <StatusPill tone={enrolmentTone(enrolment.status)}>
                            {ENROLMENT_STATUS_LABEL[enrolment.status] ?? enrolment.status}
                          </StatusPill>
                        </p>
                        <p className="text-xs text-fg-muted">{enrolment.sessionLabel}</p>
                      </div>
                      {canEdit && live && enrolment.status === "ACTIVE" && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            aria-label={`Move ${name} from ${enrolment.classGroupName} ${enrolment.armName}`}
                            onClick={() => (setNotice(null), enrolling.show({ moving: enrolment }))}
                          >
                            Move
                          </Button>
                          <Button
                            variant="ghost"
                            aria-label={`Withdraw ${name} from ${enrolment.classGroupName} ${enrolment.armName}`}
                            onClick={() => (setNotice(null), withdrawing.show(enrolment))}
                          >
                            Withdraw
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="guardians-heading" className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 id="guardians-heading" className="text-lg font-semibold tracking-tight text-fg">
                    Guardians
                  </h2>
                  <p className="mt-1 text-sm text-fg-muted">The people the school phones. The primary contact comes first.</p>
                </div>
                {canEdit && live && (
                  <Button onClick={() => (setNotice(null), addingGuardian.show(true))}>
                    <PlusIcon className="h-4 w-4" />
                    Add guardian
                  </Button>
                )}
              </div>
              <ListState
                loading={guardians.loading}
                error={guardians.error}
                empty={links.length === 0}
                emptyText="No guardian recorded yet."
                onRetry={() => void guardians.reload()}
              >
                <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
                  {links.map((link) => (
                    <li key={link.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold break-words text-fg">
                          {link.guardian.firstName} {link.guardian.lastName}{" "}
                          {link.isPrimary && <StatusPill tone="ok">Primary contact</StatusPill>}
                        </p>
                        <p className="text-xs text-fg-muted">
                          {RELATIONSHIP_LABEL[link.relationship]}
                          {link.guardian.phone ? ` · ${link.guardian.phone}` : ""}
                          {link.guardian.email ? ` · ${link.guardian.email}` : ""}
                        </p>
                      </div>
                      {canEdit && live && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            aria-label={`Edit ${link.guardian.firstName} ${link.guardian.lastName}`}
                            onClick={() => (setNotice(null), editingLink.show(link))}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            aria-label={`Remove ${link.guardian.firstName} ${link.guardian.lastName}`}
                            onClick={() => (setNotice(null), removing.show(link))}
                          >
                            Remove
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </ListState>
            </section>

            {form.n > 0 && (
              <StudentFormDialog
                key={`form-${form.n}`}
                open={form.open}
                onClose={form.hide}
                schoolCode={schoolCode}
                campuses={campuses}
                student={student}
                onDone={done(form.hide, "Saved.")}
              />
            )}
            {archiving.n > 0 && (
              <ArchiveStudentDialog
                key={`archiving-${archiving.n}`}
                open={archiving.open}
                onClose={archiving.hide}
                schoolCode={schoolCode}
                student={student}
                onDone={done(archiving.hide, "Archived.")}
              />
            )}
            {enrolling.n > 0 && enrolling.value && (
              <EnrolDialog
                key={`enrolling-${enrolling.n}`}
                open={enrolling.open}
                onClose={enrolling.hide}
                schoolCode={schoolCode}
                student={student}
                moving={enrolling.value.moving}
                onDone={done(enrolling.hide, enrolling.value.moving ? "Moved." : "Enrolled.")}
              />
            )}
            {withdrawing.n > 0 && withdrawing.value && (
              <WithdrawDialog
                key={`withdrawing-${withdrawing.n}`}
                open={withdrawing.open}
                onClose={withdrawing.hide}
                schoolCode={schoolCode}
                student={student}
                enrolment={withdrawing.value}
                onDone={done(withdrawing.hide, "Withdrawn.")}
              />
            )}
            {addingGuardian.n > 0 && (
              <AddGuardianDialog
                key={`addingGuardian-${addingGuardian.n}`}
                open={addingGuardian.open}
                onClose={addingGuardian.hide}
                schoolCode={schoolCode}
                student={student}
                hasGuardians={links.length > 0}
                onDone={(reply: Reply) =>
                  done(addingGuardian.hide, reply.data?.reactivated ? "Guardian added again." : "Guardian added.")()
                }
              />
            )}
            {editingLink.n > 0 && editingLink.value && (
              <EditLinkDialog
                key={`editingLink-${editingLink.n}`}
                open={editingLink.open}
                onClose={editingLink.hide}
                schoolCode={schoolCode}
                student={student}
                link={editingLink.value}
                onDone={done(editingLink.hide, "Saved.")}
              />
            )}
            {removing.n > 0 && removing.value && (
              <RemoveGuardianDialog
                key={`removing-${removing.n}`}
                open={removing.open}
                onClose={removing.hide}
                schoolCode={schoolCode}
                student={student}
                link={removing.value}
                onDone={done(removing.hide, "Guardian removed.")}
              />
            )}
            {duplicateToRestore && (
              <ConfirmDialog
                open={true}
                onClose={() => setDuplicateToRestore(null)}
                title={`Restore ${name}?`}
                confirmLabel="Restore anyway"
                pendingLabel="Restoring…"
                onConfirm={() => sendJson(`${root}/restore`, "POST", { allowDuplicate: true })}
                onDone={done(() => setDuplicateToRestore(null), "Restored.")}
              >
                <p>{duplicateToRestore}</p>
                <p className="mt-2 text-sm text-fg-muted">
                  Confirm that this is a distinct student who genuinely shares the same name and date of birth.
                </p>
              </ConfirmDialog>
            )}
          </>
        )}
      </ListState>
    </div>
  );
}
