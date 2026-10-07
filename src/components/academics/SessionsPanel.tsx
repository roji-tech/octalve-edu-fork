"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { SchoolType } from "@prisma/client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { SelectField } from "@/components/ui/SelectField";
import { ArrowLeftIcon, PlusIcon } from "@/components/ui/icons";
import { sendJson, type Reply } from "@/components/auth/postJson";
import {
  ActivateDialog,
  ArchivePeriodDialog,
  ArchiveSessionDialog,
  CloseSessionDialog,
  CopyForwardDialog,
  PeriodFormDialog,
  SessionFormDialog,
} from "./SessionDialogs";
import { ListState, LiveNotice, Pager, StatusPill, useDialog, type Notice } from "./parts";
import {
  SESSION_STATUS_LABEL,
  formatRange,
  periodWords,
  type CampusOption,
  type PageMeta,
  type PeriodView,
  type SessionView,
} from "./model";
import { useAfterChange, useApi } from "./useApi";

const PAGE_SIZE = 20;
const ROW = "md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_8rem_auto] md:items-center md:gap-4";

const statusPill = (session: Pick<SessionView, "status" | "archived">) =>
  session.archived ? (
    <StatusPill tone="neutral">Archived</StatusPill>
  ) : (
    <StatusPill tone={session.status === "ACTIVE" ? "ok" : session.status === "PLANNED" ? "info" : "neutral"}>
      {SESSION_STATUS_LABEL[session.status]}
    </StatusPill>
  );

/// "Sessions & terms": the school years, each with its terms (semesters, cohorts). One session is open at a time; a copy to next year is
/// previewed before it is made. Everything goes through the academics API, which decides who may do what; this shows the answer.
export function SessionsPanel({
  schoolCode,
  campuses,
  schoolType,
}: {
  schoolCode: string;
  campuses: CampusOption[];
  schoolType: SchoolType;
}) {
  const words = periodWords(schoolType);
  const [status, setStatus] = useState("live");
  const [campusId, setCampusId] = useState("");
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ status, page: String(page), limit: String(PAGE_SIZE) });
  if (campusId) params.set("campusId", campusId);
  const { reply, error, loading, reload } = useApi(`/api/v1/schools/${schoolCode}/academics/sessions?${params}`);
  const sessions = (reply?.data?.sessions as SessionView[] | undefined) ?? [];
  const meta = (reply?.meta as PageMeta | undefined) ?? null;
  const { summaryRef, afterChange } = useAfterChange(reload);

  const [notice, setNotice] = useState<Notice>(null);
  const [detail, setDetail] = useState<SessionView | null>(null);
  const form = useDialog<{ session: SessionView | null }>();
  const activating = useDialog<SessionView>();
  const closing = useDialog<SessionView>();
  const archiving = useDialog<SessionView>();
  const copying = useDialog<SessionView>();

  const scopeName = (session: SessionView) => session.campusName ?? "Whole school";
  const filtered = status !== "live" || campusId !== "";

  function done(close: () => void, text: string | ((reply: Reply) => string)) {
    return (answer: Reply) => {
      flushSync(close);
      setNotice({ variant: "success", text: typeof text === "string" ? text : text(answer) });
      void afterChange();
    };
  }

  if (detail) {
    return (
      <TermsView
        schoolCode={schoolCode}
        schoolType={schoolType}
        sessionId={detail.id}
        fallback={detail}
        onBack={() => {
          setDetail(null);
          void reload();
        }}
      />
    );
  }

  return (
    <section aria-labelledby="sessions-heading" className="space-y-4">
      <LiveNotice notice={notice} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="sessions-heading" className="text-lg font-semibold tracking-tight text-fg">
            Sessions
          </h2>
          <p className="mt-1 text-sm text-fg-muted">Each session is a school year with its {words.many}. Only one is open at a time.</p>
        </div>
        <Button
          onClick={() => {
            setNotice(null);
            form.show({ session: null });
          }}
        >
          <PlusIcon className="h-4 w-4" />
          New session
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Show"
          value={status}
          onChange={(e) => (setStatus(e.target.value), setPage(1))}
          options={[
            { value: "live", label: "Current and upcoming" },
            { value: "planned", label: "Planned" },
            { value: "active", label: "Open" },
            { value: "closed", label: "Closed" },
            { value: "archived", label: "Archived" },
            { value: "all", label: "Everything" },
          ]}
        />
        {campuses.length > 0 && (
          <SelectField
            label="Campus"
            value={campusId}
            onChange={(e) => (setCampusId(e.target.value), setPage(1))}
            options={[{ value: "", label: "Whole school and every campus" }, ...campuses.map((c) => ({ value: c.id, label: c.name }))]}
          />
        )}
      </div>

      <p ref={summaryRef} tabIndex={-1} className="text-sm text-fg-muted focus:outline-none" aria-live="polite">
        {meta ? `${meta.total} ${meta.total === 1 ? "session" : "sessions"}${filtered ? " match" : ""}` : " "}
      </p>

      <ListState
        loading={loading}
        error={error}
        empty={sessions.length === 0}
        emptyText={filtered ? "No session matches these filters." : "No sessions yet. Create the first one to start setting up the year."}
        onRetry={() => void reload()}
      >
        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <div
            aria-hidden="true"
            className={`hidden border-b border-line bg-surface-2 px-4 py-2.5 text-xs font-semibold tracking-wide text-fg-muted uppercase ${ROW}`}
          >
            <span>Session</span>
            <span>Dates</span>
            <span>Status</span>
            <span className="w-80 text-right">Actions</span>
          </div>
          <ul className="divide-y divide-line">
            {sessions.map((session) => {
              const editable = !session.archived && session.status !== "CLOSED";
              return (
                <li key={session.id} className={`flex flex-col gap-3 p-4 ${ROW}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold break-words text-fg">{session.label}</p>
                    <p className="text-xs text-fg-muted">
                      {scopeName(session)} · {session.periodCount} {session.periodCount === 1 ? words.one : words.many}
                    </p>
                  </div>
                  <p className="text-sm text-fg-2">{formatRange(session.startDate, session.endDate)}</p>
                  <p>{statusPill(session)}</p>
                  <div className="flex flex-wrap gap-2 md:w-80 md:justify-end">
                    <Button variant="secondary" aria-label={`${words.Many} of ${session.label}`} onClick={() => setDetail(session)}>
                      {words.Many}
                    </Button>
                    {editable && (
                      <Button
                        variant="secondary"
                        aria-label={`Edit ${session.label}`}
                        onClick={() => (setNotice(null), form.show({ session }))}
                      >
                        Edit
                      </Button>
                    )}
                    {!session.archived && session.status === "PLANNED" && (
                      <Button aria-label={`Open ${session.label}`} onClick={() => (setNotice(null), activating.show(session))}>
                        Open
                      </Button>
                    )}
                    {!session.archived && session.status === "ACTIVE" && (
                      <Button
                        variant="secondary"
                        aria-label={`Close ${session.label}`}
                        onClick={() => (setNotice(null), closing.show(session))}
                      >
                        Close
                      </Button>
                    )}
                    {!session.archived && (
                      <Button
                        variant="ghost"
                        aria-label={`Copy ${session.label} to next year`}
                        onClick={() => (setNotice(null), copying.show(session))}
                      >
                        Copy forward
                      </Button>
                    )}
                    {!session.archived && session.status !== "ACTIVE" && (
                      <Button
                        variant="ghost"
                        aria-label={`Archive ${session.label}`}
                        onClick={() => (setNotice(null), archiving.show(session))}
                      >
                        Archive
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </ListState>
      <Pager meta={meta} label="Pages of sessions" onPage={setPage} />

      {form.n > 0 && (
        <SessionFormDialog
          key={form.n}
          open={form.open}
          onClose={form.hide}
          schoolCode={schoolCode}
          campuses={campuses}
          session={form.value!.session}
          onDone={done(form.hide, (answer) => `Saved ${(answer.data?.session as SessionView).label}.`)}
        />
      )}
      {activating.n > 0 && (
        <ActivateDialog
          key={activating.n}
          open={activating.open}
          session={activating.value!}
          onClose={activating.hide}
          schoolCode={schoolCode}
          onDone={done(activating.hide, (answer) => {
            const closed = answer.data?.closed as { label: string } | null;
            return `${(answer.data?.session as SessionView).label} is now open${closed ? `, and ${closed.label} was closed` : ""}.`;
          })}
        />
      )}
      {closing.n > 0 && (
        <CloseSessionDialog
          key={closing.n}
          open={closing.open}
          session={closing.value!}
          onClose={closing.hide}
          schoolCode={schoolCode}
          onDone={done(closing.hide, (answer) => `${(answer.data?.session as SessionView).label} is closed.`)}
        />
      )}
      {archiving.n > 0 && (
        <ArchiveSessionDialog
          key={archiving.n}
          open={archiving.open}
          session={archiving.value!}
          onClose={archiving.hide}
          schoolCode={schoolCode}
          onDone={done(archiving.hide, (answer) => `${(answer.data?.session as SessionView).label} was archived.`)}
        />
      )}
      {copying.n > 0 && (
        <CopyForwardDialog
          key={copying.n}
          open={copying.open}
          session={copying.value!}
          onClose={copying.hide}
          schoolCode={schoolCode}
          termWords={words}
          onDone={done(copying.hide, (answer) => `${(answer.data?.session as SessionView).label} was created as a planned session.`)}
        />
      )}
    </section>
  );
}

/// One session's terms (semesters, cohorts): add, change, make current, archive. A closed or archived session is read-only.
function TermsView({
  schoolCode,
  schoolType,
  sessionId,
  fallback,
  onBack,
}: {
  schoolCode: string;
  schoolType: SchoolType;
  sessionId: string;
  fallback: SessionView;
  onBack: () => void;
}) {
  const words = periodWords(schoolType);
  const { reply, error, loading, reload } = useApi(`/api/v1/schools/${schoolCode}/academics/sessions/${sessionId}`);
  const session = (reply?.data?.session as SessionView | undefined) ?? fallback;
  const periods = (reply?.data?.periods as PeriodView[] | undefined) ?? [];
  const { summaryRef, afterChange } = useAfterChange(reload);
  const [notice, setNotice] = useState<Notice>(null);
  const form = useDialog<{ period: PeriodView | null }>();
  const archiving = useDialog<PeriodView>();
  const [busy, setBusy] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const readOnly = session.archived || session.status === "CLOSED";

  async function makeCurrent(period: PeriodView) {
    setBusy(period.id);
    const answer = await sendJson(`/api/v1/schools/${schoolCode}/academics/periods/${period.id}/current`, "POST", {});
    setBusy(null);
    setNotice(
      answer.ok
        ? { variant: "success", text: `${period.label} is now the current ${words.one}.` }
        : { variant: "error", text: answer.message ?? "That didn't work. Please try again in a moment." },
    );
    await afterChange();
  }

  const done = (close: () => void, text: string) => () => {
    flushSync(close);
    setNotice({ variant: "success", text });
    void afterChange();
  };

  return (
    <section aria-labelledby="terms-heading" className="space-y-4">
      <LiveNotice notice={notice} />
      <Button variant="ghost" onClick={onBack} className="-ml-3">
        <ArrowLeftIcon className="h-4 w-4" />
        All sessions
      </Button>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="terms-heading" ref={headingRef} tabIndex={-1} className="text-lg font-semibold tracking-tight text-fg focus:outline-none">
            {words.Many} of {session.label}
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            {formatRange(session.startDate, session.endDate)} · {session.campusName ?? "Whole school"} · {statusPill(session)}
          </p>
        </div>
        {!readOnly && (
          <Button onClick={() => (setNotice(null), form.show({ period: null }))}>
            <PlusIcon className="h-4 w-4" />
            Add a {words.one}
          </Button>
        )}
      </div>
      {readOnly && (
        <Alert variant="info" announce={false}>
          {session.archived ? "This session is archived" : "This session is closed"}, so its {words.many} can&apos;t be changed.
        </Alert>
      )}
      <p ref={summaryRef} tabIndex={-1} className="text-sm text-fg-muted focus:outline-none" aria-live="polite">
        {reply ? `${periods.length} ${periods.length === 1 ? words.one : words.many}` : " "}
      </p>
      <ListState
        loading={loading}
        error={error}
        empty={periods.length === 0}
        emptyText={`No ${words.many} yet. Add the first one.`}
        onRetry={() => void reload()}
      >
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {periods.map((period) => (
            <li key={period.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold break-words text-fg">
                  {period.ordinal}. {period.label} {period.isCurrent && <StatusPill tone="ok">Current</StatusPill>}
                </p>
                <p className="text-xs text-fg-muted">{formatRange(period.startDate, period.endDate)}</p>
              </div>
              {!readOnly && (
                <div className="flex flex-wrap gap-2">
                  {session.status === "ACTIVE" && !period.isCurrent && (
                    <Button
                      variant="secondary"
                      loading={busy === period.id}
                      aria-label={`Make ${period.label} the current ${words.one}`}
                      onClick={() => makeCurrent(period)}
                    >
                      Make current
                    </Button>
                  )}
                  <Button variant="secondary" aria-label={`Edit ${period.label}`} onClick={() => (setNotice(null), form.show({ period }))}>
                    Edit
                  </Button>
                  <Button variant="ghost" aria-label={`Archive ${period.label}`} onClick={() => (setNotice(null), archiving.show(period))}>
                    Archive
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </ListState>
      {form.n > 0 && (
        <PeriodFormDialog
          key={form.n}
          open={form.open}
          onClose={form.hide}
          schoolCode={schoolCode}
          session={session}
          period={form.value!.period}
          words={words}
          endOptional={schoolType === "VOCATIONAL"}
          onDone={done(form.hide, `Saved the ${words.one}.`)}
        />
      )}
      {archiving.n > 0 && (
        <ArchivePeriodDialog
          key={archiving.n}
          open={archiving.open}
          period={archiving.value!}
          onClose={archiving.hide}
          schoolCode={schoolCode}
          words={words}
          onDone={done(archiving.hide, `The ${words.one} was archived.`)}
        />
      )}
    </section>
  );
}
