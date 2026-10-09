"use client";

import { useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { Dialog } from "@/components/ui/Dialog";
import { SelectField } from "@/components/ui/SelectField";
import { TextField } from "@/components/ui/TextField";
import { sendJson, type Reply } from "@/components/auth/postJson";
import { ConfirmDialog, FormDialog, StatusPill, type Outcome } from "@/components/academics/parts";
import { failureText, useApi } from "@/components/academics/useApi";
import type { ClassGroupView, SessionView } from "@/components/academics/model";
import { fullName, problemText, type CampusOption, type EnrolmentView, type ImportReport, type StudentView } from "./model";

const base = (schoolCode: string) => `/api/v1/schools/${schoolCode}`;
const blankToNull = (text: string) => (text.trim() === "" ? null : text.trim());

/// The sessions a student can be enrolled in (planned or open) and the classes (arms) they can join, for the Enrol and Move dialogs and the list's class filter.
export function useEnrolmentChoices(schoolCode: string) {
  const sessions = useApi(`${base(schoolCode)}/academics/sessions?status=live&limit=100`);
  const groups = useApi(`${base(schoolCode)}/academics/class-groups?limit=100`);
  const sessionList = (sessions.reply?.data?.sessions as SessionView[] | undefined) ?? [];
  const groupList = (groups.reply?.data?.classGroups as ClassGroupView[] | undefined) ?? [];
  const arms = groupList.flatMap((group) =>
    group.arms.map((arm) => ({ value: arm.id, label: `${group.name} ${arm.name}${group.campusName ? ` · ${group.campusName}` : ""}` })),
  );
  const open = sessionList.filter((session) => session.status !== "CLOSED" && !session.archived);
  /// The session new work happens in: the open one, else the next planned.
  const current = open.find((session) => session.status === "ACTIVE") ?? open[0] ?? null;
  return { loading: sessions.loading || groups.loading, sessions: open, current, arms };
}

/// Adding or changing a student's record. The campus is chosen once, when adding.
export function StudentFormDialog({
  open,
  onClose,
  schoolCode,
  campuses,
  student,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  campuses: CampusOption[];
  student: StudentView | null;
  onDone: (reply: Reply) => void;
}) {
  const [firstName, setFirstName] = useState(student?.firstName ?? "");
  const [middleName, setMiddleName] = useState(student?.middleName ?? "");
  const [lastName, setLastName] = useState(student?.lastName ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(student?.dateOfBirth ?? "");
  const [admissionNo, setAdmissionNo] = useState(student?.admissionNo ?? "");
  const [campusId, setCampusId] = useState("");
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);

  function resetDuplicate() {
    if (duplicateNotice) setDuplicateNotice(null);
    if (allowDuplicate) setAllowDuplicate(false);
  }

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!firstName.trim()) errors.firstName = "Give the student's first name.";
    if (!lastName.trim()) errors.lastName = "Give the student's last name.";
    if (!dateOfBirth) errors.dateOfBirth = "Give the date of birth.";
    if (Object.keys(errors).length > 0) return { errors };

    const url = student ? `${base(schoolCode)}/people/students/${student.id}` : `${base(schoolCode)}/people/students`;
    const method = student ? "PATCH" : "POST";
    const payload = student
      ? {
          firstName: firstName.trim(),
          middleName: blankToNull(middleName),
          lastName: lastName.trim(),
          dateOfBirth,
          ...(admissionNo.trim() && admissionNo.trim() !== student.admissionNo ? { admissionNo: admissionNo.trim() } : {}),
          ...(allowDuplicate ? { allowDuplicate: true } : {}),
        }
      : {
          campusId: campusId || null,
          firstName: firstName.trim(),
          middleName: blankToNull(middleName),
          lastName: lastName.trim(),
          dateOfBirth,
          ...(admissionNo.trim() ? { admissionNo: admissionNo.trim() } : {}),
          ...(allowDuplicate ? { allowDuplicate: true } : {}),
        };

    const reply = await sendJson(url, method, payload);
    if (!reply.ok && reply.code === "POSSIBLE_DUPLICATE") {
      setDuplicateNotice(reply.message ?? "A student with the same name and date of birth already exists.");
      return { errors: {} };
    }
    return reply;
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={student ? `Edit ${fullName(student)}` : "Add a student"}
      description={student ? undefined : "Leave the admission number empty and the school's next number is used."}
      submitLabel={student ? "Save changes" : "Add student"}
      pendingLabel="Saving…"
      fields={["firstName", "middleName", "lastName", "dateOfBirth", "admissionNo", "campusId"]}
      onSubmit={submit}
      onDone={onDone}
      submitDisabled={Boolean(duplicateNotice && !allowDuplicate)}
    >
      {(errors, pending) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="First name"
              value={firstName}
              onChange={(e) => {
                setFirstName(e.target.value);
                resetDuplicate();
              }}
              error={errors.firstName}
              maxLength={80}
              autoComplete="off"
              disabled={pending}
            />
            <TextField
              label="Last name"
              value={lastName}
              onChange={(e) => {
                setLastName(e.target.value);
                resetDuplicate();
              }}
              error={errors.lastName}
              maxLength={80}
              autoComplete="off"
              disabled={pending}
            />
          </div>
          <TextField
            label="Middle name (optional)"
            value={middleName}
            onChange={(e) => setMiddleName(e.target.value)}
            error={errors.middleName}
            maxLength={80}
            autoComplete="off"
            disabled={pending}
          />
          <TextField
            label="Date of birth"
            type="date"
            value={dateOfBirth}
            onChange={(e) => {
              setDateOfBirth(e.target.value);
              resetDuplicate();
            }}
            error={errors.dateOfBirth}
            disabled={pending}
            min="1900-01-01"
          />
          <TextField
            label="Admission number (optional)"
            value={admissionNo}
            onChange={(e) => setAdmissionNo(e.target.value)}
            error={errors.admissionNo}
            hint={student ? undefined : "Letters, digits, / - and . — for example 2026/0001"}
            maxLength={30}
            autoComplete="off"
            disabled={pending}
          />
          {!student && campuses.length > 0 && (
            <SelectField
              label="Campus"
              value={campusId}
              onChange={(e) => setCampusId(e.target.value)}
              error={errors.campusId}
              hint="Fixed once the student is added."
              disabled={pending}
              options={[{ value: "", label: "Whole school" }, ...campuses.map((campus) => ({ value: campus.id, label: campus.name }))]}
            />
          )}
          {duplicateNotice && (
            <div className="space-y-3 rounded-xl border border-warn-line bg-warn-bg/20 p-4">
              <Alert variant="warning">{duplicateNotice}</Alert>
              <CheckboxField
                label={
                  <span>
                    <span className="font-semibold text-fg">
                      {student ? "Update anyway as a distinct student" : "Register anyway as a distinct student"}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      Confirm this is a distinct student who genuinely shares the same name and date of birth (e.g. a namesake cousin).
                    </span>
                  </span>
                }
                checked={allowDuplicate}
                onChange={(e) => setAllowDuplicate(e.target.checked)}
                disabled={pending}
              />
            </div>
          )}
        </>
      )}
    </FormDialog>
  );
}

export function ArchiveStudentDialog({
  open,
  onClose,
  schoolCode,
  student,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  student: StudentView;
  onDone: (reply: Reply) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Archive ${fullName(student)}?`}
      confirmLabel="Archive student"
      pendingLabel="Archiving…"
      danger
      onConfirm={() => sendJson(`${base(schoolCode)}/people/students/${student.id}/archive`, "POST")}
      onDone={onDone}
    >
      <p>
        They leave the student list. Their record, class history and guardians are kept, and you can restore them any time. A student who is
        still enrolled must be withdrawn first.
      </p>
    </ConfirmDialog>
  );
}

/// Enrolling a student in a class for a session — or moving an enrolment to another class of the same session.
export function EnrolDialog({
  open,
  onClose,
  schoolCode,
  student,
  moving,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  student: StudentView;
  /// When set, this enrolment is being MOVED: the session is fixed and only the class changes.
  moving: EnrolmentView | null;
  onDone: (reply: Reply) => void;
}) {
  const choices = useEnrolmentChoices(schoolCode);
  const [sessionId, setSessionId] = useState("");
  const [classArmId, setClassArmId] = useState("");
  const chosenSession = moving?.sessionId ?? (sessionId || choices.current?.id || "");

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!chosenSession) errors.sessionId = "Choose a session.";
    if (!classArmId) errors.classArmId = "Choose a class.";
    if (Object.keys(errors).length > 0) return { errors };
    return moving
      ? sendJson(`${base(schoolCode)}/people/students/${student.id}/enrolments/${moving.id}`, "PATCH", { classArmId })
      : sendJson(`${base(schoolCode)}/people/students/${student.id}/enrolments`, "POST", { sessionId: chosenSession, classArmId });
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={moving ? `Move ${fullName(student)}` : `Enrol ${fullName(student)}`}
      description={
        moving
          ? `Currently in ${moving.classGroupName} ${moving.armName} for ${moving.sessionLabel}.`
          : "A student is in one class for the whole session. To change class later, use Move."
      }
      submitLabel={moving ? "Move student" : "Enrol student"}
      pendingLabel="Saving…"
      fields={["sessionId", "classArmId"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          {moving ? null : (
            <SelectField
              label="Session"
              value={chosenSession}
              onChange={(e) => setSessionId(e.target.value)}
              error={errors.sessionId}
              disabled={pending || choices.loading}
              options={[
                { value: "", label: choices.sessions.length === 0 ? "No open or planned session" : "Choose a session…" },
                ...choices.sessions.map((s) => ({ value: s.id, label: `${s.label}${s.campusName ? ` · ${s.campusName}` : ""}` })),
              ]}
            />
          )}
          <SelectField
            label="Class"
            value={classArmId}
            onChange={(e) => setClassArmId(e.target.value)}
            error={errors.classArmId}
            disabled={pending || choices.loading}
            options={[{ value: "", label: choices.arms.length === 0 ? "No classes yet" : "Choose a class…" }, ...choices.arms]}
          />
        </>
      )}
    </FormDialog>
  );
}

export function WithdrawDialog({
  open,
  onClose,
  schoolCode,
  student,
  enrolment,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  student: StudentView;
  enrolment: EnrolmentView;
  onDone: (reply: Reply) => void;
}) {
  const [reason, setReason] = useState("");
  async function submit(): Promise<Outcome> {
    if (reason.trim().length < 5) return { errors: { reason: "Say why, in at least 5 characters." } };
    return sendJson(`${base(schoolCode)}/people/students/${student.id}/enrolments/${enrolment.id}/withdraw`, "POST", {
      reason: reason.trim(),
    });
  }
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Withdraw ${fullName(student)}?`}
      description={`They leave ${enrolment.classGroupName} ${enrolment.armName} for ${enrolment.sessionLabel}. Their record stays, and the reason is kept in the audit trail.`}
      submitLabel="Withdraw student"
      pendingLabel="Withdrawing…"
      fields={["reason"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <TextField
          label="Why are they being withdrawn?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
          maxLength={300}
          autoComplete="off"
          disabled={pending}
        />
      )}
    </FormDialog>
  );
}

/// Importing students from a spreadsheet saved as CSV. The file is checked first (a dry run: nothing is written), every problem is listed, and only a clean
/// file can be imported — all of it, or none of it.
export function ImportDialog({
  open,
  onClose,
  schoolCode,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  onDone: (report: ImportReport) => void;
}) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<"checking" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function choose(selected: File | undefined) {
    setReport(null);
    setError(null);
    if (!selected) return setFile(null);
    if (selected.size > 1024 * 1024) {
      setFile(null);
      return setError("That file is larger than 1 MB. Split it into smaller files.");
    }
    setFile({ name: selected.name, text: await selected.text() });
  }

  async function run(dryRun: boolean) {
    if (!file || busy) return;
    setBusy(dryRun ? "checking" : "importing");
    setError(null);
    const reply = await sendJson(`${base(schoolCode)}/people/students/import`, "POST", { csv: file.text, dryRun });
    setBusy(null);
    if (!reply.ok) return setError(failureText(reply.status, reply.message));
    const answer = reply.data?.report as ImportReport;
    setReport(answer);
    if (answer.committed) onDone(answer);
  }

  const problems = report ? report.rows.filter((row) => row.status === "error") : [];
  const clean = report !== null && report.headerProblems.length === 0 && report.counts.errors === 0 && report.counts.created > 0;
  const checked = report !== null && report.dryRun;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Import students"
      description="Choose a CSV file. The first line names the columns: first_name, last_name and date_of_birth (YYYY-MM-DD) are needed; admission_no, middle_name, campus, class, arm, session, guardian_name, guardian_phone, guardian_email and relationship are optional."
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="import-file" className="mb-1.5 block text-xs font-semibold tracking-wide text-fg-2 uppercase">
            CSV file
          </label>
          <input
            id="import-file"
            ref={input}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void choose(e.target.files?.[0])}
            className="block w-full text-sm text-fg file:mr-3 file:min-h-11 file:rounded-xl file:border file:border-line file:bg-surface-2 file:px-4 file:text-sm file:font-semibold file:text-fg"
          />
          <p className="mt-1.5 text-xs text-fg-muted">
            Up to 1 MB and 1,000 students. Nothing is saved until you have seen the check and confirmed.
          </p>
        </div>

        {error && <Alert variant="error">{error}</Alert>}

        <div role="status" aria-live="polite" className="empty:hidden">
          {report && report.headerProblems.length > 0 && (
            <Alert variant="error" announce={false}>
              <p className="font-semibold">The file can&apos;t be read.</p>
              <ul className="mt-1 list-disc pl-5">
                {report.headerProblems.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </Alert>
          )}
          {report && report.headerProblems.length === 0 && (
            <Alert variant={report.counts.errors === 0 ? "success" : "error"} announce={false}>
              <p className="font-semibold">
                {report.counts.errors === 0
                  ? checked
                    ? `The file is fine: ${report.counts.created} to add${report.counts.skipped ? `, ${report.counts.skipped} already in the register` : ""}.`
                    : `Done: ${report.counts.created} added${report.counts.skipped ? `, ${report.counts.skipped} already in the register` : ""}.`
                  : `${report.counts.errors} ${report.counts.errors === 1 ? "row has a problem" : "rows have problems"}. Nothing was imported — fix the file and check it again.`}
              </p>
            </Alert>
          )}
        </div>

        {problems.length > 0 && (
          <div className="max-h-72 overflow-auto rounded-xl border border-line">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Rows with problems</caption>
              <thead className="bg-surface-2 text-xs tracking-wide text-fg-muted uppercase">
                <tr>
                  <th scope="col" className="w-16 px-3 py-2 font-semibold">
                    Row
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Student
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Problem
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {problems.map((row) => (
                  <tr key={row.row}>
                    <td className="px-3 py-2 align-top text-fg-2">{row.row}</td>
                    <td className="px-3 py-2 align-top break-words text-fg">{row.name || "—"}</td>
                    <td className="px-3 py-2 align-top text-fg-2">
                      {row.problems.map((problem) => (
                        <p key={`${problem.column}-${problem.message}`}>{problemText(problem)}</p>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            {report?.committed ? "Close" : "Cancel"}
          </Button>
          {!report?.committed && (
            <Button
              variant={clean && checked ? "secondary" : "primary"}
              onClick={() => void run(true)}
              loading={busy === "checking"}
              disabled={!file || busy !== null}
            >
              {busy === "checking" ? "Checking…" : "Check the file"}
            </Button>
          )}
          {clean && checked && (
            <Button onClick={() => void run(false)} loading={busy === "importing"} disabled={busy !== null}>
              {busy === "importing"
                ? "Importing…"
                : `Import ${report!.counts.created} ${report!.counts.created === 1 ? "student" : "students"}`}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export const enrolmentTone = (status: string): "ok" | "warn" | "neutral" | "info" =>
  status === "ACTIVE" ? "ok" : status === "WITHDRAWN" ? "warn" : "neutral";
export { StatusPill };
