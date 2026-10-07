"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { SelectField } from "@/components/ui/SelectField";
import { TextField } from "@/components/ui/TextField";
import { sendJson, type Reply } from "@/components/auth/postJson";
import { ConfirmDialog, FormDialog, type Outcome } from "./parts";
import { useApi } from "./useApi";
import type { ArmView, CampusOption, ClassGroupView, SubjectView } from "./model";

const base = (schoolCode: string) => `/api/v1/schools/${schoolCode}/academics`;
const wholeNumber = (text: string): number | null | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined; // not given
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null; // null = not a whole number
};

/// A class group — "JSS 1", "Year 7", "Primary 3": its name, where it sits in the progression, and whether it belongs to one campus.
export function ClassGroupDialog({
  open,
  onClose,
  schoolCode,
  campuses,
  group,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  campuses: CampusOption[];
  group: ClassGroupView | null;
  onDone: (reply: Reply) => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [sortOrder, setSortOrder] = useState(group ? String(group.sortOrder) : "");
  const [campusId, setCampusId] = useState("");

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = "Give the class a name, such as JSS 1.";
    const order = wholeNumber(sortOrder);
    if (order === null) errors.sortOrder = "Use a whole number, such as 1.";
    if (Object.keys(errors).length > 0) return { errors };
    return group
      ? sendJson(`${base(schoolCode)}/class-groups/${group.id}`, "PATCH", {
          name: name.trim(),
          ...(order === undefined ? {} : { sortOrder: order }),
        })
      : sendJson(`${base(schoolCode)}/class-groups`, "POST", {
          name: name.trim(),
          campusId: campusId || null,
          ...(order === undefined ? {} : { sortOrder: order }),
        });
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={group ? `Edit ${group.name}` : "New class"}
      description="A class is a level of the school, such as Year 7. Its arms (7A, 7B) are added to it afterwards."
      submitLabel={group ? "Save changes" : "Create class"}
      pendingLabel="Saving…"
      fields={["name", "sortOrder", "campusId"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            maxLength={60}
            autoComplete="off"
            disabled={pending}
          />
          <TextField
            label="Order (optional)"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            error={errors.sortOrder}
            hint="Lower numbers come first, so classes are listed in the order pupils move up."
            inputMode="numeric"
            autoComplete="off"
            disabled={pending}
          />
          {!group && (
            <SelectField
              label="Belongs to"
              value={campusId}
              onChange={(e) => setCampusId(e.target.value)}
              options={[{ value: "", label: "The whole school" }, ...campuses.map((c) => ({ value: c.id, label: c.name }))]}
              error={errors.campusId}
              hint="Fixed once created."
              disabled={pending}
            />
          )}
        </>
      )}
    </FormDialog>
  );
}

/// An arm — a stream or section of a class ("A", "Gold") — with an optional capacity.
export function ArmDialog({
  open,
  onClose,
  schoolCode,
  group,
  arm,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  group: ClassGroupView;
  arm: ArmView | null;
  onDone: (reply: Reply) => void;
}) {
  const [name, setName] = useState(arm?.name ?? "");
  const [capacity, setCapacity] = useState(arm?.capacity != null ? String(arm.capacity) : "");

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = "Give the arm a name, such as A.";
    const seats = wholeNumber(capacity);
    if (seats === null) errors.capacity = "Use a whole number, or leave it empty.";
    if (Object.keys(errors).length > 0) return { errors };
    const body = { name: name.trim(), capacity: seats === undefined ? null : seats };
    return arm
      ? sendJson(`${base(schoolCode)}/arms/${arm.id}`, "PATCH", body)
      : sendJson(`${base(schoolCode)}/class-groups/${group.id}/arms`, "POST", body);
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={arm ? `Edit arm ${arm.name} of ${group.name}` : `Add an arm to ${group.name}`}
      submitLabel={arm ? "Save changes" : "Add arm"}
      pendingLabel="Saving…"
      fields={["name", "capacity"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            maxLength={30}
            autoComplete="off"
            disabled={pending}
          />
          <TextField
            label="Capacity (optional)"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            error={errors.capacity}
            hint="The most pupils it should hold, from 1 to 1000. Leave empty for no limit."
            inputMode="numeric"
            autoComplete="off"
            disabled={pending}
          />
        </>
      )}
    </FormDialog>
  );
}

export function SubjectDialog({
  open,
  onClose,
  schoolCode,
  subject,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  subject: SubjectView | null;
  onDone: (reply: Reply) => void;
}) {
  const [name, setName] = useState(subject?.name ?? "");
  const [code, setCode] = useState(subject?.code ?? "");

  async function submit(): Promise<Outcome> {
    if (!name.trim()) return { errors: { name: "Give the subject a name, such as Mathematics." } };
    const body = { name: name.trim(), code: code.trim() === "" ? null : code.trim() };
    return subject
      ? sendJson(`${base(schoolCode)}/subjects/${subject.id}`, "PATCH", body)
      : sendJson(`${base(schoolCode)}/subjects`, "POST", body);
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={subject ? `Edit ${subject.name}` : "New subject"}
      description="Subjects belong to the whole school. You choose which classes study each one separately."
      submitLabel={subject ? "Save changes" : "Create subject"}
      pendingLabel="Saving…"
      fields={["name", "code"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            maxLength={60}
            autoComplete="off"
            disabled={pending}
          />
          <TextField
            label="Short code (optional)"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={errors.code}
            hint="1 to 12 letters or digits, such as MTH. Shown on reports."
            maxLength={12}
            autoComplete="off"
            disabled={pending}
          />
        </>
      )}
    </FormDialog>
  );
}

/// Which subjects a class studies: the whole list is saved at once.
export function OfferingsDialog({
  open,
  onClose,
  schoolCode,
  group,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  group: ClassGroupView;
  onDone: (reply: Reply) => void;
}) {
  const all = useApi(`${base(schoolCode)}/subjects?limit=100`);
  const current = useApi(`${base(schoolCode)}/class-groups/${group.id}/subjects`);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const subjects = (all.reply?.data?.subjects as SubjectView[] | undefined) ?? [];
  const chosen = picked ?? new Set(((current.reply?.data?.subjects as SubjectView[] | undefined) ?? []).map((s) => s.id));
  const ready = all.reply !== null && current.reply !== null;
  const loadError = all.error ?? current.error;

  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Subjects studied in ${group.name}`}
      description="Tick every subject this class studies."
      submitLabel="Save subjects"
      pendingLabel="Saving…"
      submitDisabled={!ready}
      fields={["subjectIds"]}
      onSubmit={async () => sendJson(`${base(schoolCode)}/class-groups/${group.id}/subjects`, "PUT", { subjectIds: [...chosen] })}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          {loadError && <Alert variant="error">{loadError}</Alert>}
          {!loadError && !ready && (
            <p className="text-sm text-fg-muted" aria-busy="true">
              Loading subjects…
            </p>
          )}
          {ready && subjects.length === 0 && (
            <p className="text-sm text-fg-muted">The school has no subjects yet. Create some on this page first, then come back.</p>
          )}
          {ready && subjects.length > 0 && (
            <fieldset className="max-h-72 overflow-y-auto rounded-xl border border-line px-3 py-1">
              <legend className="sr-only">Subjects</legend>
              {subjects.map((subject) => (
                <CheckboxField
                  key={subject.id}
                  label={subject.code ? `${subject.name} (${subject.code})` : subject.name}
                  checked={chosen.has(subject.id)}
                  onChange={(e) => toggle(subject.id, e.target.checked)}
                  disabled={pending}
                />
              ))}
            </fieldset>
          )}
          {errors.subjectIds && <p className="text-xs font-medium text-danger-text">{errors.subjectIds}</p>}
        </>
      )}
    </FormDialog>
  );
}

type ArchiveKind = "class" | "arm" | "subject";
/// One confirmation for archiving a class, an arm or a subject, saying what it does and does not do. The server refuses when something still depends on it
/// (a class with arms, a subject a class still studies) and the reason is shown here.
export function ArchiveDialog({
  open,
  onClose,
  schoolCode,
  kind,
  target,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  kind: ArchiveKind;
  target: { id: string; name: string };
  onDone: (reply: Reply) => void;
}) {
  const path = kind === "class" ? "class-groups" : kind === "arm" ? "arms" : "subjects";
  const consequence = {
    class: "It leaves the lists. A class with live arms can't be archived — archive its arms first.",
    arm: "It leaves the lists.",
    subject: "It leaves the lists. A subject a class still studies can't be archived — remove it from those classes first.",
  }[kind];
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Archive ${target.name}?`}
      confirmLabel={`Archive ${kind}`}
      pendingLabel="Archiving…"
      danger
      onConfirm={() => sendJson(`${base(schoolCode)}/${path}/${target.id}/archive`, "POST", {})}
      onDone={onDone}
    >
      <p>{consequence} Nothing is deleted, and it cannot be edited again.</p>
    </ConfirmDialog>
  );
}
