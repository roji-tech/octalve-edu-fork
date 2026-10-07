"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { SelectField } from "@/components/ui/SelectField";
import { TextField } from "@/components/ui/TextField";
import { sendJson, type Reply } from "@/components/auth/postJson";
import { ConfirmDialog, FormDialog, type Outcome } from "./parts";
import { failureText } from "./useApi";
import {
  formatDate,
  formatInstant,
  formatRange,
  plusOneYear,
  type CampusOption,
  type CopyForwardPlan,
  type PeriodView,
  type SessionView,
} from "./model";

const base = (schoolCode: string) => `/api/v1/schools/${schoolCode}/academics`;

/// Create a session (label, dates, whole school or one campus) or change one (label and dates; its campus is fixed).
export function SessionFormDialog({
  open,
  onClose,
  schoolCode,
  campuses,
  session,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  campuses: CampusOption[];
  session: SessionView | null;
  onDone: (reply: Reply) => void;
}) {
  const [label, setLabel] = useState(session?.label ?? "");
  const [startDate, setStartDate] = useState(session?.startDate ?? "");
  const [endDate, setEndDate] = useState(session?.endDate ?? "");
  const [campusId, setCampusId] = useState("");

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!label.trim()) errors.label = "Give the session a name, such as 2026/2027.";
    if (!startDate) errors.startDate = "Choose the first day.";
    if (!endDate) errors.endDate = "Choose the last day.";
    if (Object.keys(errors).length > 0) return { errors };
    return session
      ? sendJson(`${base(schoolCode)}/sessions/${session.id}`, "PATCH", { label: label.trim(), startDate, endDate })
      : sendJson(`${base(schoolCode)}/sessions`, "POST", { label: label.trim(), startDate, endDate, campusId: campusId || null });
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={session ? `Edit ${session.label}` : "New session"}
      description={
        session
          ? "Change its name or dates. Its terms must stay inside the new dates."
          : "A session is one school year. It starts as planned; nothing uses it until you open it."
      }
      submitLabel={session ? "Save changes" : "Create session"}
      pendingLabel="Saving…"
      fields={["label", "startDate", "endDate", "campusId"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <TextField
            label="Name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            error={errors.label}
            hint="For example 2026/2027."
            maxLength={40}
            autoComplete="off"
            disabled={pending}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="First day"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              error={errors.startDate}
              disabled={pending}
            />
            <TextField
              label="Last day"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              error={errors.endDate}
              disabled={pending}
            />
          </div>
          {!session && (
            <SelectField
              label="Applies to"
              value={campusId}
              onChange={(e) => setCampusId(e.target.value)}
              options={[{ value: "", label: "The whole school" }, ...campuses.map((c) => ({ value: c.id, label: c.name }))]}
              error={errors.campusId}
              hint="A campus can keep its own calendar; otherwise it follows the whole school's."
              disabled={pending}
            />
          )}
        </>
      )}
    </FormDialog>
  );
}

/// Open a session. If another one is open for the same campus (or the whole school), the person must say they want it closed — it is never closed silently,
/// and because that ends a school year on the spot it asks for their password.
export function ActivateDialog({
  open,
  session,
  onClose,
  schoolCode,
  onDone,
}: {
  open: boolean;
  session: SessionView;
  onClose: () => void;
  schoolCode: string;
  onDone: (reply: Reply) => void;
}) {
  const [closeCurrent, setCloseCurrent] = useState(false);
  const [password, setPassword] = useState("");
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Open ${session.label}?`}
      description="Only one session can be open at a time for the whole school (or for each campus that keeps its own calendar)."
      submitLabel="Open session"
      pendingLabel="Opening…"
      fields={["password"]}
      onSubmit={async () => {
        if (closeCurrent && !password) return { errors: { password: "Enter your password to confirm." } };
        return sendJson(
          `${base(schoolCode)}/sessions/${session.id}/activate`,
          "POST",
          closeCurrent ? { closeCurrent, password } : { closeCurrent },
        );
      }}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <CheckboxField
            label="If another session is already open, close it first"
            checked={closeCurrent}
            onChange={(e) => setCloseCurrent(e.target.checked)}
            disabled={pending}
          />
          {closeCurrent && (
            <TextField
              label="Your password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
              hint="Closing the current session ends it straight away, so we ask you to confirm it is you."
              disabled={pending}
            />
          )}
        </>
      )}
    </FormDialog>
  );
}

/// Close a session: a countdown, not a button. By default it closes a day from now and can be cancelled until then; "Close sooner" asks for the
/// person's password and closes it in a minute. Either way nothing happens now, and nothing is deleted.
export function CloseSessionDialog({
  open,
  session,
  onClose,
  schoolCode,
  onDone,
  sooner = false,
}: {
  open: boolean;
  session: SessionView;
  onClose: () => void;
  schoolCode: string;
  onDone: (reply: Reply) => void;
  /// Start with "close sooner" chosen (the row's "Close sooner…" button).
  sooner?: boolean;
}) {
  const [soon, setSoon] = useState(sooner);
  const [password, setPassword] = useState("");
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Close ${session.label}?`}
      description={
        session.closeAt
          ? `A close is already planned for ${formatInstant(session.closeAt)}. You can bring it forward below, or leave it.`
          : "Closing starts a 24-hour countdown. Until it ends nothing changes, and you can cancel."
      }
      submitLabel={soon ? "Close in 1 minute" : "Start 24-hour countdown"}
      pendingLabel="Working…"
      fields={["password"]}
      onSubmit={async () => {
        if (soon && !password) return { errors: { password: "Enter your password to confirm." } };
        return sendJson(`${base(schoolCode)}/sessions/${session.id}/close`, "POST", soon ? { password } : {});
      }}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <p className="text-sm leading-relaxed text-fg-2">
            When it closes, the session and its terms become read-only and there is no current term. Nothing is deleted, and an
            administrator can reopen it later with a reason.
          </p>
          <CheckboxField
            label="Close sooner — in 1 minute instead of 24 hours"
            checked={soon}
            onChange={(e) => setSoon(e.target.checked)}
            disabled={pending}
          />
          {soon && (
            <TextField
              label="Your password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
              hint="Closing this fast is hard to take back, so we ask you to confirm it is you."
              disabled={pending}
            />
          )}
        </>
      )}
    </FormDialog>
  );
}

/// Take back a planned close while it is still in the future.
export function CancelCloseDialog({
  open,
  session,
  onClose,
  schoolCode,
  onDone,
}: {
  open: boolean;
  session: SessionView;
  onClose: () => void;
  schoolCode: string;
  onDone: (reply: Reply) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Cancel the planned close of ${session.label}?`}
      confirmLabel="Cancel the close"
      pendingLabel="Cancelling…"
      onConfirm={() => sendJson(`${base(schoolCode)}/sessions/${session.id}/close/cancel`, "POST", {})}
      onDone={onDone}
    >
      <p>
        {session.closeAt ? `It was going to close on ${formatInstant(session.closeAt)}. ` : ""}The session stays open and nothing changes.
        You can plan a new close whenever you like.
      </p>
    </ConfirmDialog>
  );
}

/// Reopen a closed session, with a reason that goes in the audit trail. Refused while another session is open for the same campus (or the school).
export function ReopenSessionDialog({
  open,
  session,
  onClose,
  schoolCode,
  onDone,
}: {
  open: boolean;
  session: SessionView;
  onClose: () => void;
  schoolCode: string;
  onDone: (reply: Reply) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Reopen ${session.label}?`}
      description="It becomes open again and its terms can be changed. No term is current until you choose one. The reason is kept in the audit trail."
      submitLabel="Reopen session"
      pendingLabel="Reopening…"
      fields={["reason"]}
      onSubmit={async () => {
        const text = reason.replace(/\s+/g, " ").trim();
        if (text.length < 5) return { errors: { reason: "Give a reason of at least 5 characters." } };
        return sendJson(`${base(schoolCode)}/sessions/${session.id}/reopen`, "POST", { reason: text });
      }}
      onDone={onDone}
    >
      {(errors, pending) => (
        <TextField
          label="Why is it being reopened?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
          maxLength={300}
          disabled={pending}
        />
      )}
    </FormDialog>
  );
}

export function ArchiveSessionDialog({
  open,
  session,
  onClose,
  schoolCode,
  onDone,
}: {
  open: boolean;
  session: SessionView;
  onClose: () => void;
  schoolCode: string;
  onDone: (reply: Reply) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Archive ${session.label}?`}
      confirmLabel="Archive session"
      pendingLabel="Archiving…"
      danger
      onConfirm={() => sendJson(`${base(schoolCode)}/sessions/${session.id}/archive`, "POST", {})}
      onDone={onDone}
    >
      <p>
        It and its terms leave the lists. Nothing is deleted — results and reports that refer to them keep working — but it cannot be edited
        again.
      </p>
    </ConfirmDialog>
  );
}

const CONFLICT_TEXT = (conflict: CopyForwardPlan["conflicts"][number]) =>
  conflict.kind === "ALREADY_COPIED"
    ? `This session has already been copied${conflict.with ? ` to "${conflict.with.label}"` : ""}.`
    : conflict.kind === "LABEL_TAKEN"
      ? "A session with this name already exists. Choose another name."
      : `The new dates overlap ${conflict.with ? `"${conflict.with.label}"` : "another session"}. Choose another start date.`;

/// "Copy to next year": pick the new start date (and, if wanted, name), PREVIEW exactly what would be created — and any clash — then create it. The
/// preview writes nothing; the copy is a planned session whose terms are shifted by whole years and none of them current.
export function CopyForwardDialog({
  open,
  session,
  onClose,
  schoolCode,
  termWords,
  onDone,
}: {
  open: boolean;
  session: SessionView;
  onClose: () => void;
  schoolCode: string;
  termWords: { one: string; many: string };
  onDone: (reply: Reply) => void;
}) {
  const [startDate, setStartDate] = useState(plusOneYear(session.startDate));
  const [label, setLabel] = useState("");
  const [plan, setPlan] = useState<CopyForwardPlan | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});

  const body = (dryRun: boolean) => ({ startDate, dryRun, ...(label.trim() ? { label: label.trim() } : {}) });
  const changed = () => {
    setPlan(null);
    setPreviewError(null);
  };

  async function preview() {
    if (!startDate) return setFieldError({ startDate: "Choose the first day of the new session." });
    setFieldError({});
    setPreviewing(true);
    setPreviewError(null);
    const reply = await sendJson(`${base(schoolCode)}/sessions/${session.id}/copy-forward`, "POST", body(true));
    setPreviewing(false);
    if (reply.ok) return setPlan(reply.data!.plan as CopyForwardPlan);
    const inline: Record<string, string> = {};
    for (const detail of reply.details ?? []) inline[detail.path.replace(/^body\./, "")] = detail.message;
    // The server can only guess the next name from a year pair ("2026/2027"); for any other name it asks for one, and the field says so in words.
    if (inline.label && !label.trim()) inline.label = "The next name can't be worked out from this one. Type the new session's name.";
    if (Object.keys(inline).length > 0 && reply.details?.every((d) => d.path === "body.startDate" || d.path === "body.label"))
      setFieldError(inline);
    else setPreviewError(failureText(reply.status, reply.message));
  }

  const blocked = !plan || plan.conflicts.length > 0;
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Copy ${session.label} to next year`}
      description={`Creates a planned session with the same ${termWords.many}, moved by whole years. Preview it first.`}
      submitLabel="Create session"
      pendingLabel="Creating…"
      submitDisabled={blocked}
      fields={["startDate", "label"]}
      onSubmit={async () => {
        if (blocked) return { errors: { startDate: "Preview the copy first." } };
        return sendJson(`${base(schoolCode)}/sessions/${session.id}/copy-forward`, "POST", body(false));
      }}
      onDone={onDone}
      wide
      extraActions={
        <Button variant="secondary" onClick={preview} loading={previewing}>
          {previewing ? "Checking…" : plan ? "Preview again" : "Preview"}
        </Button>
      }
    >
      {(errors, pending) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="New first day"
              type="date"
              value={startDate}
              onChange={(e) => (setStartDate(e.target.value), changed())}
              error={errors.startDate ?? fieldError.startDate}
              hint={`The old session starts on ${formatDate(session.startDate)}.`}
              disabled={pending}
            />
            <TextField
              label="New name (optional)"
              value={label}
              onChange={(e) => (setLabel(e.target.value), changed())}
              error={errors.label ?? fieldError.label}
              hint="Leave empty to continue a year pair such as 2027/2028. Any other name must be typed."
              maxLength={40}
              autoComplete="off"
              disabled={pending}
            />
          </div>
          {previewError && <Alert variant="error">{previewError}</Alert>}
          {plan && (
            <div role="status" aria-live="polite" className="space-y-3">
              <h3 className="text-sm font-semibold text-fg">What would be created</h3>
              <p className="text-sm text-fg-2">
                <strong className="font-semibold text-fg">{plan.session.label}</strong> ·{" "}
                {formatRange(plan.session.startDate, plan.session.endDate)}
              </p>
              {plan.periods.length > 0 ? (
                <ul className="divide-y divide-line rounded-xl border border-line text-sm">
                  {plan.periods.map((period) => (
                    <li key={period.ordinal} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:justify-between">
                      <span className="font-medium text-fg">{period.label}</span>
                      <span className="text-fg-muted">{formatRange(period.startDate, period.endDate)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-fg-muted">The old session has no {termWords.many} to copy.</p>
              )}
              {plan.conflicts.length > 0 ? (
                <Alert variant="warning" announce={false} title="It can't be created yet">
                  <ul className="list-disc pl-5">
                    {plan.conflicts.map((conflict, index) => (
                      <li key={index}>{CONFLICT_TEXT(conflict)}</li>
                    ))}
                  </ul>
                </Alert>
              ) : (
                <Alert variant="success" announce={false}>
                  No clashes. Create it when you are happy with this.
                </Alert>
              )}
            </div>
          )}
        </>
      )}
    </FormDialog>
  );
}

/// Add a term/semester/cohort to a session, or change one. The kind comes from the school's type and is never asked for.
export function PeriodFormDialog({
  open,
  onClose,
  schoolCode,
  session,
  period,
  words,
  endOptional,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  session: SessionView;
  period: PeriodView | null;
  words: { one: string; One: string };
  endOptional: boolean;
  onDone: (reply: Reply) => void;
}) {
  const [label, setLabel] = useState(period?.label ?? "");
  const [startDate, setStartDate] = useState(period?.startDate ?? "");
  const [endDate, setEndDate] = useState(period?.endDate ?? "");
  const [ordinal, setOrdinal] = useState(period ? String(period.ordinal) : "");

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!label.trim()) errors.label = `Give the ${words.one} a name, such as ${words.One} 1.`;
    if (!startDate) errors.startDate = "Choose the first day.";
    if (!endDate && !endOptional) errors.endDate = "Choose the last day.";
    const position = ordinal.trim() === "" ? undefined : Number(ordinal);
    if (position !== undefined && !Number.isInteger(position)) errors.ordinal = "Use a whole number, such as 1.";
    if (Object.keys(errors).length > 0) return { errors };
    const body = { label: label.trim(), startDate, endDate: endDate || null, ...(position === undefined ? {} : { ordinal: position }) };
    return period
      ? sendJson(`${base(schoolCode)}/periods/${period.id}`, "PATCH", body)
      : sendJson(`${base(schoolCode)}/sessions/${session.id}/periods`, "POST", body);
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={period ? `Edit ${period.label}` : `Add a ${words.one} to ${session.label}`}
      description={`It must fall inside ${formatRange(session.startDate, session.endDate)} and not overlap another ${words.one}.`}
      submitLabel={period ? "Save changes" : `Add ${words.one}`}
      pendingLabel="Saving…"
      fields={["label", "startDate", "endDate", "ordinal"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <TextField
            label="Name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            error={errors.label}
            maxLength={60}
            autoComplete="off"
            disabled={pending}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="First day"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              error={errors.startDate}
              disabled={pending}
            />
            <TextField
              label={endOptional ? "Last day (optional)" : "Last day"}
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              error={errors.endDate}
              hint={endOptional ? "Leave empty if it has no fixed end." : undefined}
              disabled={pending}
            />
          </div>
          <TextField
            label="Position (optional)"
            value={ordinal}
            onChange={(e) => setOrdinal(e.target.value)}
            error={errors.ordinal}
            hint={`1 for the first ${words.one} of the year. Leave empty to add it last.`}
            inputMode="numeric"
            autoComplete="off"
            disabled={pending}
          />
        </>
      )}
    </FormDialog>
  );
}

export function ArchivePeriodDialog({
  open,
  period,
  onClose,
  schoolCode,
  words,
  onDone,
}: {
  open: boolean;
  period: PeriodView;
  onClose: () => void;
  schoolCode: string;
  words: { one: string };
  onDone: (reply: Reply) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Archive ${period.label}?`}
      confirmLabel={`Archive ${words.one}`}
      pendingLabel="Archiving…"
      danger
      onConfirm={() => sendJson(`${base(schoolCode)}/periods/${period.id}/archive`, "POST", {})}
      onDone={onDone}
    >
      <p>
        It leaves the list and cannot be the current {words.one} any more. Nothing is deleted; anything that already refers to it keeps
        working.
      </p>
    </ConfirmDialog>
  );
}
