"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/Button";
import { SelectField } from "@/components/ui/SelectField";
import { PlusIcon } from "@/components/ui/icons";
import type { Reply } from "@/components/auth/postJson";
import { SchemeArchiveDialog, SchemeFormDialog } from "./AssessmentDialogs";
import { ListState, LiveNotice, Pager, StatusPill, useDialog, type Notice } from "./parts";
import type { PageMeta, SchemeView } from "./model";
import { useAfterChange, useApi } from "./useApi";

/// "Assessment": how a mark is built — continuous-assessment components plus the exam make up the total. A school has a default scheme and may give a class
/// its own. Once results use a scheme it is locked: it can't be edited, only replaced by a new version.
export function AssessmentPanel({ schoolCode, readOnly = false }: { schoolCode: string; readOnly?: boolean }) {
  const [status, setStatus] = useState("live");
  const [page, setPage] = useState(1);
  const { reply, error, loading, reload } = useApi(
    `/api/v1/schools/${schoolCode}/academics/assessment-schemes?status=${status}&page=${page}&limit=20`,
  );
  const schemes = (reply?.data?.assessmentSchemes as SchemeView[] | undefined) ?? [];
  const meta = (reply?.meta as PageMeta | undefined) ?? null;
  const { summaryRef, afterChange } = useAfterChange(reload);
  const [notice, setNotice] = useState<Notice>(null);
  const form = useDialog<{ mode: "create" | "edit" | "version"; scheme: SchemeView | null }>();
  const archiving = useDialog<SchemeView>();

  const done = (close: () => void, text: (reply: Reply) => string) => (answer: Reply) => {
    flushSync(close);
    setNotice({ variant: "success", text: text(answer) });
    void afterChange();
  };
  const schemeOf = (answer: Reply) => answer.data?.assessmentScheme as SchemeView;

  return (
    <section aria-labelledby="assessment-heading" className="space-y-4">
      <LiveNotice notice={notice} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="assessment-heading" className="text-lg font-semibold tracking-tight text-fg">
            Assessment schemes
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            How a mark is built. One scheme can be the school&apos;s default; a class may have its own.
          </p>
        </div>
        {!readOnly && (
          <Button onClick={() => (setNotice(null), form.show({ mode: "create", scheme: null }))}>
            <PlusIcon className="h-4 w-4" />
            New scheme
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
        {meta ? `${meta.total} ${meta.total === 1 ? "scheme" : "schemes"}` : " "}
      </p>
      <ListState
        loading={loading}
        error={error}
        empty={schemes.length === 0}
        emptyText={status === "live" ? "No assessment scheme yet. Create the school's default one first." : "Nothing to show here."}
        onRetry={() => void reload()}
      >
        <ul className="space-y-3">
          {schemes.map((scheme) => (
            <li key={scheme.id} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold break-words text-fg">{scheme.name}</h3>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <span>{scheme.classGroupName ? `For ${scheme.classGroupName}` : "School default"}</span>
                    <span>· Version {scheme.version}</span>
                    {scheme.archived ? (
                      <StatusPill tone="neutral">Archived</StatusPill>
                    ) : scheme.locked ? (
                      <StatusPill tone="info">In use — locked</StatusPill>
                    ) : (
                      <StatusPill tone="ok">Not used yet</StatusPill>
                    )}
                  </p>
                </div>
                {!readOnly && !scheme.archived && (
                  <div className="flex flex-wrap gap-2">
                    {scheme.locked ? (
                      <Button
                        variant="secondary"
                        aria-label={`Make a new version of ${scheme.name}`}
                        onClick={() => (setNotice(null), form.show({ mode: "version", scheme }))}
                      >
                        New version
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        aria-label={`Edit ${scheme.name}`}
                        onClick={() => (setNotice(null), form.show({ mode: "edit", scheme }))}
                      >
                        Edit
                      </Button>
                    )}
                    <Button variant="ghost" aria-label={`Archive ${scheme.name}`} onClick={() => (setNotice(null), archiving.show(scheme))}>
                      Archive
                    </Button>
                  </div>
                )}
              </div>
              <dl className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2 text-sm">
                {scheme.components.map((component) => (
                  <div key={component.id} className="rounded-xl bg-surface-2 px-3 py-2">
                    <dt className="text-xs text-fg-muted">{component.name}</dt>
                    <dd className="font-semibold text-fg">{component.maxScore}</dd>
                  </div>
                ))}
                <div className="rounded-xl bg-surface-2 px-3 py-2">
                  <dt className="text-xs text-fg-muted">Exam</dt>
                  <dd className="font-semibold text-fg">{scheme.examMax}</dd>
                </div>
                <div className="rounded-xl bg-brand-tint px-3 py-2">
                  <dt className="text-xs text-brand-fg">Total</dt>
                  <dd className="font-semibold text-brand-fg">{scheme.totalMax}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </ListState>
      <Pager meta={meta} label="Pages of schemes" onPage={setPage} />

      {form.n > 0 && (
        <SchemeFormDialog
          key={`form-${form.n}`}
          open={form.open}
          onClose={form.hide}
          schoolCode={schoolCode}
          mode={form.value!.mode}
          scheme={form.value!.scheme}
          onDone={done(form.hide, (a) =>
            form.value!.mode === "version"
              ? `Version ${schemeOf(a).version} of ${schemeOf(a).name} is ready.`
              : `Saved ${schemeOf(a).name}.`,
          )}
        />
      )}
      {archiving.n > 0 && (
        <SchemeArchiveDialog
          key={`archiving-${archiving.n}`}
          open={archiving.open}
          onClose={archiving.hide}
          schoolCode={schoolCode}
          scheme={archiving.value!}
          onDone={done(archiving.hide, (a) => `${schemeOf(a).name} was archived.`)}
        />
      )}
    </section>
  );
}
