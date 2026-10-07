"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { PlusIcon, TrashIcon } from "@/components/ui/icons";
import { sendJson, type Reply } from "@/components/auth/postJson";
import { ConfirmDialog, FormDialog, type Outcome } from "./parts";
import { markText, parseMark, type ScaleView } from "./model";

const base = (schoolCode: string) => `/api/v1/schools/${schoolCode}/academics`;
const MAX_BANDS = 12;
type Row = { min: string; max: string; letter: string; remark: string };

const STANDARD: Row[] = [
  { min: "70", max: "100", letter: "A", remark: "Excellent" },
  { min: "60", max: "70", letter: "B", remark: "Very good" },
  { min: "50", max: "60", letter: "C", remark: "Good" },
  { min: "45", max: "50", letter: "D", remark: "Fair" },
  { min: "40", max: "45", letter: "E", remark: "Pass" },
  { min: "0", max: "40", letter: "F", remark: "Fail" },
];

/// A grade scale turns a score into a letter and a remark. The bands must cover 0 to 100 with no gap or overlap; a score exactly on a boundary belongs to
/// the higher band, and 100 belongs to the top one. `create` makes a new scale, `edit` changes one nothing uses yet, `version` makes the next version of one
/// results already use.
export function ScaleFormDialog({
  open,
  onClose,
  schoolCode,
  mode,
  scale,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  mode: "create" | "edit" | "version";
  scale: ScaleView | null;
  onDone: (reply: Reply) => void;
}) {
  const [name, setName] = useState(scale?.name ?? "");
  const [rows, setRows] = useState<Row[]>(
    scale
      ? [...scale.bands].reverse().map((b) => ({ min: markText(b.min), max: markText(b.max), letter: b.letter, remark: b.remark }))
      : [{ min: "", max: "", letter: "", remark: "" }],
  );
  const patchRow = (index: number, change: Partial<Row>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = "Give the scale a name, such as Standard A–F.";
    rows.forEach((row, index) => {
      if (parseMark(row.min) === null || parseMark(row.max) === null)
        errors[`bands.${index}`] = "Enter where this band starts and ends, as numbers.";
      else if (!row.letter.trim() || !row.remark.trim()) errors[`bands.${index}`] = "Give this band a letter and a remark.";
    });
    if (Object.keys(errors).length > 0) return { errors };
    const body = {
      name: name.trim(),
      bands: rows.map((row) => ({
        min: parseMark(row.min),
        max: parseMark(row.max),
        letter: row.letter.trim(),
        remark: row.remark.trim(),
      })),
    };
    if (mode === "create") return sendJson(`${base(schoolCode)}/grade-scales`, "POST", body);
    if (mode === "edit") return sendJson(`${base(schoolCode)}/grade-scales/${scale!.id}`, "PATCH", body);
    return sendJson(`${base(schoolCode)}/grade-scales/${scale!.id}/new-version`, "POST", body);
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={mode === "create" ? "New grade scale" : mode === "edit" ? `Edit ${scale!.name}` : `New version of ${scale!.name}`}
      description={
        mode === "version"
          ? `Results already use version ${scale!.version}, so it stays exactly as it is. This creates version ${scale!.version + 1} for new results.`
          : "Each band starts where the one below it ends: the lowest starts at 0 and the highest ends at 100."
      }
      submitLabel={mode === "version" ? "Create new version" : mode === "edit" ? "Save changes" : "Create scale"}
      pendingLabel="Saving…"
      fields={["name", "bands"]}
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
          <fieldset className="space-y-3">
            <legend className="mb-1 text-xs font-semibold tracking-wide text-fg-2 uppercase">Bands</legend>
            {rows.map((row, index) => (
              <div key={index} className="rounded-xl border border-line p-3">
                <div className="grid gap-3 sm:grid-cols-[6rem_6rem_5rem_minmax(0,1fr)_auto] sm:items-end">
                  <TextField
                    label={`Band ${index + 1} from`}
                    value={row.min}
                    onChange={(e) => patchRow(index, { min: e.target.value })}
                    inputMode="decimal"
                    autoComplete="off"
                    disabled={pending}
                  />
                  <TextField
                    label={`Band ${index + 1} up to`}
                    value={row.max}
                    onChange={(e) => patchRow(index, { max: e.target.value })}
                    inputMode="decimal"
                    autoComplete="off"
                    disabled={pending}
                  />
                  <TextField
                    label={`Band ${index + 1} letter`}
                    value={row.letter}
                    onChange={(e) => patchRow(index, { letter: e.target.value })}
                    maxLength={4}
                    autoComplete="off"
                    disabled={pending}
                  />
                  <TextField
                    label={`Band ${index + 1} remark`}
                    value={row.remark}
                    onChange={(e) => patchRow(index, { remark: e.target.value })}
                    maxLength={40}
                    autoComplete="off"
                    disabled={pending}
                  />
                  <Button
                    variant="ghost"
                    aria-label={`Remove band ${index + 1}`}
                    disabled={pending || rows.length === 1}
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </div>
                {errors[`bands.${index}`] && <p className="mt-2 text-xs font-medium text-danger-text">{errors[`bands.${index}`]}</p>}
              </div>
            ))}
            {errors.bands && <p className="text-xs font-medium text-danger-text">{errors.bands}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={pending || rows.length >= MAX_BANDS}
                onClick={() => setRows((current) => [...current, { min: "", max: "", letter: "", remark: "" }])}
              >
                <PlusIcon className="h-4 w-4" />
                Add a band
              </Button>
              {mode === "create" && (
                <Button variant="ghost" disabled={pending} onClick={() => setRows(STANDARD)}>
                  Fill in a standard A–F scale
                </Button>
              )}
            </div>
          </fieldset>
        </>
      )}
    </FormDialog>
  );
}

export function ScaleActionDialog({
  open,
  onClose,
  schoolCode,
  scale,
  action,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  scale: ScaleView;
  action: "make-default" | "archive";
  onDone: (reply: Reply) => void;
}) {
  const makeDefault = action === "make-default";
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={makeDefault ? `Make ${scale.name} the default?` : `Archive ${scale.name}?`}
      confirmLabel={makeDefault ? "Make default" : "Archive scale"}
      pendingLabel={makeDefault ? "Saving…" : "Archiving…"}
      danger={!makeDefault}
      onConfirm={() => sendJson(`${base(schoolCode)}/grade-scales/${scale.id}/${action}`, "POST", {})}
      onDone={onDone}
    >
      {makeDefault ? (
        <p>New results will be graded with this scale. The current default stays available, and results already graded do not change.</p>
      ) : (
        <p>It leaves the list and can&apos;t be used for new results. Results already graded with it keep working. Nothing is deleted.</p>
      )}
    </ConfirmDialog>
  );
}
