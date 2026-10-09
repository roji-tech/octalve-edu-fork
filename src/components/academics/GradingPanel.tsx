"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/Button";
import { SelectField } from "@/components/ui/SelectField";
import { PlusIcon } from "@/components/ui/icons";
import type { Reply } from "@/components/auth/postJson";
import { ScaleActionDialog, ScaleFormDialog } from "./GradingDialogs";
import { ListState, LiveNotice, Pager, StatusPill, useDialog, type Notice } from "./parts";
import type { BandView, PageMeta, ScaleView } from "./model";
import { useAfterChange, useApi } from "./useApi";

const range = (band: BandView) => (band.max === 100 ? `${band.min} to 100` : `${band.min} to under ${band.max}`);

/// "Grading": the scale that turns a score into a letter and a remark. Exactly one is the school's default. Once results use a scale it is locked:
/// changing it makes a new version, and results already graded do not change.
export function GradingPanel({ schoolCode, readOnly = false }: { schoolCode: string; readOnly?: boolean }) {
  const [status, setStatus] = useState("live");
  const [page, setPage] = useState(1);
  const { reply, error, loading, reload } = useApi(
    `/api/v1/schools/${schoolCode}/academics/grade-scales?status=${status}&page=${page}&limit=20`,
  );
  const scales = (reply?.data?.gradeScales as ScaleView[] | undefined) ?? [];
  const meta = (reply?.meta as PageMeta | undefined) ?? null;
  const { summaryRef, afterChange } = useAfterChange(reload);
  const [notice, setNotice] = useState<Notice>(null);
  const form = useDialog<{ mode: "create" | "edit" | "version"; scale: ScaleView | null }>();
  const action = useDialog<{ scale: ScaleView; action: "make-default" | "archive" }>();

  const done = (close: () => void, text: (reply: Reply) => string) => (answer: Reply) => {
    flushSync(close);
    setNotice({ variant: "success", text: text(answer) });
    void afterChange();
  };
  const scaleOf = (answer: Reply) => answer.data?.gradeScale as ScaleView;

  return (
    <section aria-labelledby="grading-heading" className="space-y-4">
      <LiveNotice notice={notice} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="grading-heading" className="text-lg font-semibold tracking-tight text-fg">
            Grade scales
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            A score on a boundary belongs to the higher band, and 100 belongs to the top one. The first scale you create becomes the
            default.
          </p>
        </div>
        {!readOnly && (
          <Button onClick={() => (setNotice(null), form.show({ mode: "create", scale: null }))}>
            <PlusIcon className="h-4 w-4" />
            New scale
          </Button>
        )}
      </div>
      <div className="max-w-xs">
        <SelectField
          label="Show"
          value={status}
          onChange={(e) => (setStatus(e.target.value), setPage(1))}
          options={[
            { value: "live", label: "In use" },
            { value: "archived", label: "Archived" },
            { value: "all", label: "Everything" },
          ]}
        />
      </div>
      <p ref={summaryRef} tabIndex={-1} className="text-sm text-fg-muted focus:outline-none" aria-live="polite">
        {meta ? `${meta.total} ${meta.total === 1 ? "scale" : "scales"}` : " "}
      </p>
      <ListState
        loading={loading}
        error={error}
        empty={scales.length === 0}
        emptyText={status === "live" ? "No grade scale yet. Create the school's first one." : "Nothing to show here."}
        onRetry={() => void reload()}
      >
        <ul className="space-y-3">
          {scales.map((scale) => (
            <li key={scale.id} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold break-words text-fg">{scale.name}</h3>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <span>Version {scale.version}</span>
                    {scale.isDefault && <StatusPill tone="ok">Default</StatusPill>}
                    {scale.archived ? (
                      <StatusPill tone="neutral">Archived</StatusPill>
                    ) : scale.locked ? (
                      <StatusPill tone="info">In use — locked</StatusPill>
                    ) : (
                      <StatusPill tone="neutral">Not used yet</StatusPill>
                    )}
                  </p>
                </div>
                {!readOnly && !scale.archived && (
                  <div className="flex flex-wrap gap-2">
                    {scale.locked ? (
                      <Button
                        variant="secondary"
                        aria-label={`Make a new version of ${scale.name}`}
                        onClick={() => (setNotice(null), form.show({ mode: "version", scale }))}
                      >
                        New version
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        aria-label={`Edit ${scale.name}`}
                        onClick={() => (setNotice(null), form.show({ mode: "edit", scale }))}
                      >
                        Edit
                      </Button>
                    )}
                    {!scale.isDefault && (
                      <>
                        <Button
                          variant="secondary"
                          aria-label={`Make ${scale.name} the default`}
                          onClick={() => (setNotice(null), action.show({ scale, action: "make-default" }))}
                        >
                          Make default
                        </Button>
                        <Button
                          variant="ghost"
                          aria-label={`Archive ${scale.name}`}
                          onClick={() => (setNotice(null), action.show({ scale, action: "archive" }))}
                        >
                          Archive
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <table className="mt-3 w-full text-left text-sm">
                <caption className="sr-only">Bands of {scale.name}</caption>
                <thead>
                  <tr className="text-xs tracking-wide text-fg-muted uppercase">
                    <th scope="col" className="w-16 py-1 pr-3 font-semibold">
                      Grade
                    </th>
                    <th scope="col" className="py-1 pr-3 font-semibold">
                      Score
                    </th>
                    <th scope="col" className="py-1 font-semibold">
                      Remark
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[...scale.bands].reverse().map((band) => (
                    <tr key={band.id}>
                      <th scope="row" className="py-1.5 pr-3 font-semibold text-fg">
                        {band.letter}
                      </th>
                      <td className="py-1.5 pr-3 text-fg-2">{range(band)}</td>
                      <td className="py-1.5 text-fg-2">{band.remark}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      </ListState>
      <Pager meta={meta} label="Pages of grade scales" onPage={setPage} />

      {form.n > 0 && (
        <ScaleFormDialog
          key={`form-${form.n}`}
          open={form.open}
          onClose={form.hide}
          schoolCode={schoolCode}
          mode={form.value!.mode}
          scale={form.value!.scale}
          onDone={done(form.hide, (a) =>
            form.value!.mode === "version" ? `Version ${scaleOf(a).version} of ${scaleOf(a).name} is ready.` : `Saved ${scaleOf(a).name}.`,
          )}
        />
      )}
      {action.n > 0 && (
        <ScaleActionDialog
          key={`action-${action.n}`}
          open={action.open}
          onClose={action.hide}
          schoolCode={schoolCode}
          scale={action.value!.scale}
          action={action.value!.action}
          onDone={done(action.hide, (a) =>
            action.value!.action === "make-default" ? `${scaleOf(a).name} is now the default scale.` : `${scaleOf(a).name} was archived.`,
          )}
        />
      )}
    </section>
  );
}
