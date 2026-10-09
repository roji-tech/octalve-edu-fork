"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/Button";
import { SelectField } from "@/components/ui/SelectField";
import { TextField } from "@/components/ui/TextField";
import { PlusIcon } from "@/components/ui/icons";
import type { Reply } from "@/components/auth/postJson";
import { FOCUS_RING } from "@/components/shell/nav";
import { ListState, LiveNotice, Pager, StatusPill, useDialog, type Notice } from "@/components/academics/parts";
import { useAfterChange, useApi } from "@/components/academics/useApi";
import { ImportDialog, StudentFormDialog, useEnrolmentChoices } from "./StudentDialogs";
import { fullName, type CampusOption, type ImportReport, type PageMeta, type StudentView } from "./model";

const PAGE_SIZE = 20;
const ROW = "md:grid md:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1.4fr)_minmax(0,1.4fr)] md:items-center md:gap-4";
const ALL = "";
const NOT_ENROLLED = "none";

/// "Students": the register. Everyone with access can look; an administrator adds, imports and exports. Every list, change and file goes through the people API,
/// which decides who may do what and which campus's students each person sees; this shows the answer.
export function StudentsPanel({ schoolCode, campuses, canEdit }: { schoolCode: string; campuses: CampusOption[]; canEdit: boolean }) {
  const choices = useEnrolmentChoices(schoolCode);
  const [status, setStatus] = useState("live");
  const [place, setPlace] = useState(ALL); // "" = every student, "none" = not enrolled this session, otherwise a class (arm) id
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const sessionId = choices.current?.id ?? null;
  const params = new URLSearchParams({ status, page: String(page), limit: String(PAGE_SIZE) });
  if (q) params.set("q", q);
  if (sessionId) params.set("sessionId", sessionId);
  if (sessionId && place === NOT_ENROLLED) params.set("notEnrolled", "true");
  else if (sessionId && place !== ALL) params.set("classArmId", place);
  const root = `/api/v1/schools/${schoolCode}/people/students`;
  const { reply, error, loading, reload } = useApi(choices.loading ? null : `${root}?${params}`);
  const students = (reply?.data?.students as StudentView[] | undefined) ?? [];
  const meta = (reply?.meta as PageMeta | undefined) ?? null;
  const { summaryRef, afterChange } = useAfterChange(reload);

  const [notice, setNotice] = useState<Notice>(null);
  const form = useDialog<true>();
  const importing = useDialog<true>();

  // The search box waits for a pause in typing, and only acts when the text really changed.
  useEffect(() => {
    if (searchText.trim() === q) return;
    const timer = setTimeout(() => (setQ(searchText.trim()), setPage(1)), 300);
    return () => clearTimeout(timer);
  }, [searchText, q]);

  const filtered = status !== "live" || q !== "" || place !== ALL;
  const exportParams = new URLSearchParams({ status });
  if (q) exportParams.set("q", q);
  if (sessionId) exportParams.set("sessionId", sessionId);
  if (sessionId && place === NOT_ENROLLED) exportParams.set("notEnrolled", "true");
  else if (sessionId && place !== ALL) exportParams.set("classArmId", place);

  const done = (close: () => void, text: string | ((reply: Reply) => string)) => (answer: Reply) => {
    flushSync(close);
    setNotice({ variant: "success", text: typeof text === "string" ? text : text(answer) });
    void afterChange();
  };

  return (
    <section aria-labelledby="students-heading" className="space-y-4">
      <LiveNotice notice={notice} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="students-heading" className="text-lg font-semibold tracking-tight text-fg">
            Students
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            {canEdit
              ? "Everyone enrolled or waiting to be, with their class and guardians."
              : "The school's students, with their class and guardians. Only an administrator can change this."}
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                setNotice(null);
                form.show(true);
              }}
            >
              <PlusIcon className="h-4 w-4" />
              Add student
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setNotice(null);
                importing.show(true);
              }}
            >
              Import…
            </Button>
            <a
              href={`${root}/export?${exportParams}`}
              download
              className={`inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-surface px-4 py-3 text-sm font-semibold text-fg transition-colors hover:bg-surface-2 ${FOCUS_RING}`}
            >
              Export
            </a>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          label="Search"
          type="search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Name or admission number"
          autoComplete="off"
          maxLength={100}
        />
        <SelectField
          label="Class"
          value={place}
          onChange={(e) => (setPlace(e.target.value), setPage(1))}
          disabled={!sessionId}
          hint={sessionId ? `For ${choices.current?.label}` : choices.loading ? undefined : "No open or planned session yet."}
          options={[{ value: ALL, label: "All students" }, { value: NOT_ENROLLED, label: "Not in a class yet" }, ...choices.arms]}
        />
        <SelectField
          label="Show"
          value={status}
          onChange={(e) => (setStatus(e.target.value), setPage(1))}
          options={[
            { value: "live", label: "Current students" },
            { value: "archived", label: "Archived" },
            { value: "all", label: "Everyone" },
          ]}
        />
      </div>

      <p ref={summaryRef} tabIndex={-1} className="text-sm text-fg-muted focus:outline-none" aria-live="polite">
        {meta ? `${meta.total} ${meta.total === 1 ? "student" : "students"}` : " "}
      </p>
      <ListState
        loading={loading || choices.loading}
        error={error}
        empty={students.length === 0}
        emptyText={
          filtered
            ? "No student matches these filters."
            : canEdit
              ? "No students yet. Add the first one, or import a file."
              : "No students yet."
        }
        onRetry={() => void reload()}
      >
        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <div
            aria-hidden="true"
            className={`hidden border-b border-line bg-surface-2 px-4 py-2.5 text-xs font-semibold tracking-wide text-fg-muted uppercase ${ROW}`}
          >
            <span>Name</span>
            <span>Number</span>
            <span>Class</span>
            <span>Campus</span>
          </div>
          <ul className="divide-y divide-line">
            {students.map((student) => (
              <li key={student.id} className={`flex flex-col gap-1 p-4 ${ROW}`}>
                <p className="min-w-0 text-sm font-semibold break-words text-fg">
                  <Link
                    href={`/schools/${schoolCode}/people/students/${student.id}`}
                    className={`inline-flex min-h-11 items-center rounded underline-offset-4 hover:underline ${FOCUS_RING}`}
                  >
                    {fullName(student)}
                  </Link>{" "}
                  {student.archived && <StatusPill tone="neutral">Archived</StatusPill>}
                </p>
                <p className="text-sm text-fg-2">
                  <span className="text-fg-muted md:hidden">Number: </span>
                  {student.admissionNo}
                </p>
                <p className="text-sm text-fg-2">
                  {student.enrolment ? (
                    `${student.enrolment.classGroupName} ${student.enrolment.armName}`
                  ) : sessionId ? (
                    <span className="text-fg-muted">Not in a class</span>
                  ) : (
                    "—"
                  )}
                </p>
                <p className="text-sm text-fg-2">{student.campusName ?? "Whole school"}</p>
              </li>
            ))}
          </ul>
        </div>
      </ListState>
      <Pager meta={meta} label="Pages of students" onPage={setPage} />

      {form.n > 0 && (
        <StudentFormDialog
          key={`form-${form.n}`}
          open={form.open}
          onClose={form.hide}
          schoolCode={schoolCode}
          campuses={campuses}
          student={null}
          onDone={done(form.hide, (answer) => {
            const created = answer.data?.student as StudentView | undefined;
            return created ? `Added ${fullName(created)} (${created.admissionNo}).` : "Student added.";
          })}
        />
      )}
      {importing.n > 0 && (
        <ImportDialog
          key={`importing-${importing.n}`}
          open={importing.open}
          onClose={importing.hide}
          schoolCode={schoolCode}
          onDone={(report: ImportReport) => {
            setNotice({
              variant: "success",
              text: `Imported ${report.counts.created} ${report.counts.created === 1 ? "student" : "students"}${report.counts.skipped ? ` (${report.counts.skipped} already in the register)` : ""}.`,
            });
            void afterChange();
          }}
        />
      )}
    </section>
  );
}
