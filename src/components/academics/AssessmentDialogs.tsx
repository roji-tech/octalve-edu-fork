"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { SelectField } from "@/components/ui/SelectField";
import { TextField } from "@/components/ui/TextField";
import { PlusIcon, TrashIcon } from "@/components/ui/icons";
import { sendJson, type Reply } from "@/components/auth/postJson";
import { ConfirmDialog, FormDialog, type Outcome } from "./parts";
import { useApi } from "./useApi";
import { markText, parseMark, type ClassGroupView, type SchemeView } from "./model";

const base = (schoolCode: string) => `/api/v1/schools/${schoolCode}/academics`;
const MAX_COMPONENTS = 10;
type Row = { name: string; max: string };

/// A scheme says how a mark is built: continuous-assessment components plus the exam add up to the total. `create` makes a new one for a class (or the
/// whole school); `edit` changes one nothing uses yet; `version` makes the next version of one results already use (the old one stays as it was).
export function SchemeFormDialog({
  open,
  onClose,
  schoolCode,
  mode,
  scheme,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  mode: "create" | "edit" | "version";
  scheme: SchemeView | null;
  onDone: (reply: Reply) => void;
}) {
  const groups = useApi(mode === "create" ? `${base(schoolCode)}/class-groups?limit=100` : null);
  const groupList = (groups.reply?.data?.classGroups as ClassGroupView[] | undefined) ?? [];
  const [name, setName] = useState(scheme?.name ?? "");
  const [classGroupId, setClassGroupId] = useState("");
  const [total, setTotal] = useState(scheme ? markText(scheme.totalMax) : "100");
  const [exam, setExam] = useState(scheme ? markText(scheme.examMax) : "");
  const [rows, setRows] = useState<Row[]>(
    scheme ? scheme.components.map((c) => ({ name: c.name, max: markText(c.maxScore) })) : [{ name: "", max: "" }],
  );

  const patchRow = (index: number, change: Partial<Row>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const sum = rows.reduce((acc, row) => acc + (parseMark(row.max) ?? 0), 0) + (parseMark(exam) ?? 0);
  const totalNumber = parseMark(total);
  const balanced = totalNumber !== null && Math.round(sum * 100) === Math.round(totalNumber * 100);

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = "Give the scheme a name, such as Standard.";
    const totalMax = parseMark(total);
    const examMax = parseMark(exam);
    if (totalMax === null) errors.totalMax = "Enter the total, such as 100.";
    if (examMax === null) errors.examMax = "Enter the exam mark (0 if there is no exam).";
    rows.forEach((row, index) => {
      if (!row.name.trim()) errors[`components.${index}`] = "Give this component a name and a maximum mark.";
      else if (parseMark(row.max) === null) errors[`components.${index}`] = "Enter its maximum mark, such as 20.";
    });
    if (Object.keys(errors).length > 0) return { errors };
    const body = {
      name: name.trim(),
      totalMax,
      examMax,
      components: rows.map((row) => ({ name: row.name.trim(), maxScore: parseMark(row.max) })),
    };
    if (mode === "create")
      return sendJson(`${base(schoolCode)}/assessment-schemes`, "POST", { ...body, classGroupId: classGroupId || null });
    if (mode === "edit") return sendJson(`${base(schoolCode)}/assessment-schemes/${scheme!.id}`, "PATCH", body);
    return sendJson(`${base(schoolCode)}/assessment-schemes/${scheme!.id}/new-version`, "POST", body);
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={mode === "create" ? "New assessment scheme" : mode === "edit" ? `Edit ${scheme!.name}` : `New version of ${scheme!.name}`}
      description={
        mode === "version"
          ? `Results already use version ${scheme!.version}, so it stays exactly as it is. This creates version ${scheme!.version + 1} for new results.`
          : "The components and the exam must add up to the total."
      }
      submitLabel={mode === "version" ? "Create new version" : mode === "edit" ? "Save changes" : "Create scheme"}
      pendingLabel="Saving…"
      fields={["name", "classGroupId", "totalMax", "examMax", "components"]}
      onSubmit={submit}
      onDone={onDone}
      wide
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
          {mode === "create" && (
            <SelectField
              label="Applies to"
              value={classGroupId}
              onChange={(e) => setClassGroupId(e.target.value)}
              options={[
                { value: "", label: "The whole school (the default)" },
                ...groupList.map((g) => ({ value: g.id, label: g.campusName ? `${g.name} · ${g.campusName}` : g.name })),
              ]}
              error={errors.classGroupId}
              hint="A class with its own scheme uses it instead of the school's default."
              disabled={pending}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Total mark"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              error={errors.totalMax}
              inputMode="decimal"
              autoComplete="off"
              disabled={pending}
            />
            <TextField
              label="Exam mark"
              value={exam}
              onChange={(e) => setExam(e.target.value)}
              error={errors.examMax}
              hint="The most the exam is worth."
              inputMode="decimal"
              autoComplete="off"
              disabled={pending}
            />
          </div>
          <fieldset className="space-y-3">
            <legend className="mb-1 text-xs font-semibold tracking-wide text-fg-2 uppercase">Continuous assessment components</legend>
            {rows.map((row, index) => (
              <div key={index} className="rounded-xl border border-line p-3">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
                  <TextField
                    label={`Component ${index + 1} name`}
                    value={row.name}
                    onChange={(e) => patchRow(index, { name: e.target.value })}
                    maxLength={40}
                    autoComplete="off"
                    disabled={pending}
                  />
                  <TextField
                    label={`Component ${index + 1} maximum`}
                    value={row.max}
                    onChange={(e) => patchRow(index, { max: e.target.value })}
                    inputMode="decimal"
                    autoComplete="off"
                    disabled={pending}
                  />
                  <Button
                    variant="ghost"
                    aria-label={`Remove component ${index + 1}`}
                    disabled={pending || rows.length === 1}
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </div>
                {errors[`components.${index}`] && (
                  <p className="mt-2 text-xs font-medium text-danger-text">{errors[`components.${index}`]}</p>
                )}
              </div>
            ))}
            {errors.components && <p className="text-xs font-medium text-danger-text">{errors.components}</p>}
            <Button
              variant="secondary"
              disabled={pending || rows.length >= MAX_COMPONENTS}
              onClick={() => setRows((current) => [...current, { name: "", max: "" }])}
            >
              <PlusIcon className="h-4 w-4" />
              Add a component
            </Button>
          </fieldset>
          <p className={`text-sm ${balanced ? "text-ok-fg" : "text-fg-2"}`}>
            Components and exam add up to <strong className="font-semibold">{Math.round(sum * 100) / 100}</strong> of{" "}
            <strong className="font-semibold">{totalNumber ?? "?"}</strong>
            {balanced ? " — that matches." : "."}
          </p>
        </>
      )}
    </FormDialog>
  );
}

export function SchemeArchiveDialog({
  open,
  onClose,
  schoolCode,
  scheme,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  scheme: SchemeView;
  onDone: (reply: Reply) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Archive ${scheme.name}?`}
      confirmLabel="Archive scheme"
      pendingLabel="Archiving…"
      danger
      onConfirm={() => sendJson(`${base(schoolCode)}/assessment-schemes/${scheme.id}/archive`, "POST", {})}
      onDone={onDone}
    >
      <p>
        Results already recorded with it keep working. New results can&apos;t use it, and{" "}
        {scheme.classGroupName ? `${scheme.classGroupName} will` : "the school will"} need a new scheme. Nothing is deleted, and it cannot
        be edited again.
      </p>
    </ConfirmDialog>
  );
}
