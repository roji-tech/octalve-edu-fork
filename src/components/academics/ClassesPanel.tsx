"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { PlusIcon } from "@/components/ui/icons";
import type { Reply } from "@/components/auth/postJson";
import { ArchiveDialog, ArmDialog, ClassGroupDialog, OfferingsDialog, SubjectDialog } from "./ClassDialogs";
import { ListState, LiveNotice, Pager, StatusPill, useDialog, type Notice } from "./parts";
import type { ArmView, CampusOption, ClassGroupView, PageMeta, SubjectView } from "./model";
import { useAfterChange, useApi } from "./useApi";

type ArchiveTarget = { kind: "class" | "arm" | "subject"; id: string; name: string };

/// "Classes & subjects": the school's levels with their arms, the subjects it teaches, and which classes study which. Everything goes through the
/// academics API; nothing here is ever deleted, only archived.
export function ClassesPanel({
  schoolCode,
  campuses,
  readOnly = false,
}: {
  schoolCode: string;
  campuses: CampusOption[];
  readOnly?: boolean;
}) {
  const root = `/api/v1/schools/${schoolCode}/academics`;
  const [groupPage, setGroupPage] = useState(1);
  const groups = useApi(`${root}/class-groups?limit=20&page=${groupPage}`);
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [subjectPage, setSubjectPage] = useState(1);
  const subjects = useApi(`${root}/subjects?limit=20&page=${subjectPage}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  const groupList = (groups.reply?.data?.classGroups as ClassGroupView[] | undefined) ?? [];
  const subjectList = (subjects.reply?.data?.subjects as SubjectView[] | undefined) ?? [];
  const groupMeta = (groups.reply?.meta as PageMeta | undefined) ?? null;
  const subjectMeta = (subjects.reply?.meta as PageMeta | undefined) ?? null;

  const reloadBoth = async () => {
    await Promise.all([groups.reload(), subjects.reload()]);
  };
  const { summaryRef, afterChange } = useAfterChange(reloadBoth);
  const [notice, setNotice] = useState<Notice>(null);

  const groupForm = useDialog<{ group: ClassGroupView | null }>();
  const armForm = useDialog<{ group: ClassGroupView; arm: ArmView | null }>();
  const subjectForm = useDialog<{ subject: SubjectView | null }>();
  const offerings = useDialog<ClassGroupView>();
  const archiving = useDialog<ArchiveTarget>();

  // The search box waits for a pause in typing, and only acts when the text really changed.
  useEffect(() => {
    if (searchText.trim() === q) return;
    const timer = setTimeout(() => (setQ(searchText.trim()), setSubjectPage(1)), 300);
    return () => clearTimeout(timer);
  }, [searchText, q]);

  const done = (close: () => void, text: string | ((reply: Reply) => string)) => (answer: Reply) => {
    flushSync(close);
    setNotice({ variant: "success", text: typeof text === "string" ? text : text(answer) });
    void afterChange();
  };

  return (
    <div className="space-y-10">
      <LiveNotice notice={notice} />

      <section aria-labelledby="classes-heading" className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="classes-heading" className="text-lg font-semibold tracking-tight text-fg">
              Classes and arms
            </h2>
            <p className="mt-1 text-sm text-fg-muted">A class is a level (Year 7); an arm is a section of it (7A, 7B).</p>
          </div>
          {!readOnly && (
            <Button onClick={() => (setNotice(null), groupForm.show({ group: null }))}>
              <PlusIcon className="h-4 w-4" />
              New class
            </Button>
          )}
        </div>
        <p ref={summaryRef} tabIndex={-1} className="text-sm text-fg-muted focus:outline-none" aria-live="polite">
          {groupMeta ? `${groupMeta.total} ${groupMeta.total === 1 ? "class" : "classes"}` : " "}
        </p>
        <ListState
          loading={groups.loading}
          error={groups.error}
          empty={groupList.length === 0}
          emptyText="No classes yet. Create the first one — for example Year 7."
          onRetry={() => void groups.reload()}
        >
          <ul className="space-y-3">
            {groupList.map((group) => (
              <li key={group.id} className="rounded-2xl border border-line bg-surface p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold break-words text-fg">{group.name}</h3>
                    <p className="text-xs text-fg-muted">
                      {group.campusName ?? "Whole school"} · {group.subjectCount} {group.subjectCount === 1 ? "subject" : "subjects"}
                    </p>
                  </div>
                  {!readOnly && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        aria-label={`Subjects of ${group.name}`}
                        onClick={() => (setNotice(null), offerings.show(group))}
                      >
                        Subjects
                      </Button>
                      <Button
                        variant="secondary"
                        aria-label={`Add an arm to ${group.name}`}
                        onClick={() => (setNotice(null), armForm.show({ group, arm: null }))}
                      >
                        Add arm
                      </Button>
                      <Button
                        variant="secondary"
                        aria-label={`Edit ${group.name}`}
                        onClick={() => (setNotice(null), groupForm.show({ group }))}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        aria-label={`Archive ${group.name}`}
                        onClick={() => (setNotice(null), archiving.show({ kind: "class", id: group.id, name: group.name }))}
                      >
                        Archive
                      </Button>
                    </div>
                  )}
                </div>
                {group.arms.length > 0 ? (
                  <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
                    {group.arms.map((arm) => (
                      <li key={arm.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm text-fg">
                          <span className="font-medium">{arm.name}</span>
                          <span className="ml-2 text-xs text-fg-muted">{arm.capacity ? `Up to ${arm.capacity} pupils` : "No limit"}</span>
                        </p>
                        {!readOnly && (
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                              aria-label={`Edit arm ${arm.name} of ${group.name}`}
                              onClick={() => (setNotice(null), armForm.show({ group, arm }))}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              aria-label={`Archive arm ${arm.name} of ${group.name}`}
                              onClick={() => (
                                setNotice(null),
                                archiving.show({ kind: "arm", id: arm.id, name: `${group.name} ${arm.name}` })
                              )}
                            >
                              Archive
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-fg-muted">No arms yet.</p>
                )}
              </li>
            ))}
          </ul>
        </ListState>
        <Pager meta={groupMeta} label="Pages of classes" onPage={setGroupPage} />
      </section>

      <section aria-labelledby="subjects-heading" className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="subjects-heading" className="text-lg font-semibold tracking-tight text-fg">
              Subjects
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              The subjects the school teaches. Choose which classes study each one from the class above.
            </p>
          </div>
          {!readOnly && (
            <Button onClick={() => (setNotice(null), subjectForm.show({ subject: null }))}>
              <PlusIcon className="h-4 w-4" />
              New subject
            </Button>
          )}
        </div>
        <div className="max-w-sm">
          <TextField
            label="Search subjects"
            type="search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Name or code"
            autoComplete="off"
            maxLength={64}
          />
        </div>
        <ListState
          loading={subjects.loading}
          error={subjects.error}
          empty={subjectList.length === 0}
          emptyText={q ? "No subject matches that search." : "No subjects yet. Create the first one — for example Mathematics."}
          onRetry={() => void subjects.reload()}
        >
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {subjectList.map((subject) => (
              <li key={subject.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-semibold break-words text-fg">
                  {subject.name} {subject.code && <StatusPill tone="neutral">{subject.code}</StatusPill>}
                </p>
                {!readOnly && (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      aria-label={`Edit ${subject.name}`}
                      onClick={() => (setNotice(null), subjectForm.show({ subject }))}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label={`Archive ${subject.name}`}
                      onClick={() => (setNotice(null), archiving.show({ kind: "subject", id: subject.id, name: subject.name }))}
                    >
                      Archive
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </ListState>
        <Pager meta={subjectMeta} label="Pages of subjects" onPage={setSubjectPage} />
      </section>

      {groupForm.n > 0 && (
        <ClassGroupDialog
          key={`groupForm-${groupForm.n}`}
          open={groupForm.open}
          onClose={groupForm.hide}
          schoolCode={schoolCode}
          campuses={campuses}
          group={groupForm.value!.group}
          onDone={done(groupForm.hide, (a) => `Saved ${(a.data?.classGroup as ClassGroupView).name}.`)}
        />
      )}
      {armForm.n > 0 && (
        <ArmDialog
          key={`armForm-${armForm.n}`}
          open={armForm.open}
          onClose={armForm.hide}
          schoolCode={schoolCode}
          group={armForm.value!.group}
          arm={armForm.value!.arm}
          onDone={done(armForm.hide, (a) => `Saved arm ${(a.data?.arm as ArmView).name} of ${armForm.value!.group.name}.`)}
        />
      )}
      {subjectForm.n > 0 && (
        <SubjectDialog
          key={`subjectForm-${subjectForm.n}`}
          open={subjectForm.open}
          onClose={subjectForm.hide}
          schoolCode={schoolCode}
          subject={subjectForm.value!.subject}
          onDone={done(subjectForm.hide, (a) => `Saved ${(a.data?.subject as SubjectView).name}.`)}
        />
      )}
      {offerings.n > 0 && (
        <OfferingsDialog
          key={`offerings-${offerings.n}`}
          open={offerings.open}
          onClose={offerings.hide}
          schoolCode={schoolCode}
          group={offerings.value!}
          onDone={done(offerings.hide, (a) =>
            a.data?.changed ? `Saved the subjects of ${offerings.value!.name}.` : "Nothing needed changing.",
          )}
        />
      )}
      {archiving.n > 0 && (
        <ArchiveDialog
          key={`archiving-${archiving.n}`}
          open={archiving.open}
          onClose={archiving.hide}
          schoolCode={schoolCode}
          kind={archiving.value!.kind}
          target={archiving.value!}
          onDone={done(archiving.hide, `${archiving.value!.name} was archived.`)}
        />
      )}
    </div>
  );
}
