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
import { StaffFormDialog } from "./StaffDialogs";
import { CATEGORY_LABEL, fullName, type CampusOption, type PageMeta, type StaffView } from "./model";

const PAGE_SIZE = 20;
const ROW = "md:grid md:grid-cols-[minmax(0,2fr)_8rem_minmax(0,1.2fr)_minmax(0,1.6fr)] md:items-center md:gap-4";

/// How a record's sign-in reads in a list: nothing yet, an invitation out, or the account it is linked to.
export function AccountPill({ account }: { account: StaffView["account"] }) {
  if (account.state === "none") return <StatusPill tone="neutral">No sign-in</StatusPill>;
  if (account.state === "invited") return <StatusPill tone="info">Invited</StatusPill>;
  if (account.deactivated) return <StatusPill tone="warn">Signed-in access off</StatusPill>;
  return <StatusPill tone="ok">Can sign in</StatusPill>;
}

/// "Staff": the school's staff records — teachers and everyone else — and who of them can sign in. Everyone with access can look; an administrator changes things.
export function StaffPanel({ schoolCode, campuses, canEdit }: { schoolCode: string; campuses: CampusOption[]; canEdit: boolean }) {
  const [status, setStatus] = useState("live");
  const [category, setCategory] = useState("");
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ status, page: String(page), limit: String(PAGE_SIZE) });
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  const { reply, error, loading, reload } = useApi(`/api/v1/schools/${schoolCode}/people/staff?${params}`);
  const staff = (reply?.data?.staff as StaffView[] | undefined) ?? [];
  const meta = (reply?.meta as PageMeta | undefined) ?? null;
  const { summaryRef, afterChange } = useAfterChange(reload);
  const [notice, setNotice] = useState<Notice>(null);
  const form = useDialog<true>();

  useEffect(() => {
    if (searchText.trim() === q) return;
    const timer = setTimeout(() => (setQ(searchText.trim()), setPage(1)), 300);
    return () => clearTimeout(timer);
  }, [searchText, q]);

  const filtered = status !== "live" || q !== "" || category !== "";
  const done = (close: () => void, text: string | ((reply: Reply) => string)) => (answer: Reply) => {
    flushSync(close);
    setNotice({ variant: "success", text: typeof text === "string" ? text : text(answer) });
    void afterChange();
  };

  return (
    <section aria-labelledby="staff-heading" className="space-y-4">
      <LiveNotice notice={notice} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="staff-heading" className="text-lg font-semibold tracking-tight text-fg">
            Staff
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            {canEdit
              ? "Everyone who works at the school, with or without a sign-in."
              : "Everyone who works at the school. Only an administrator can change this."}
          </p>
        </div>
        {canEdit && (
          <Button
            onClick={() => {
              setNotice(null);
              form.show(true);
            }}
          >
            <PlusIcon className="h-4 w-4" />
            Add staff member
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          label="Search"
          type="search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Name, email or phone"
          autoComplete="off"
          maxLength={100}
        />
        <SelectField
          label="Kind"
          value={category}
          onChange={(e) => (setCategory(e.target.value), setPage(1))}
          options={[
            { value: "", label: "All staff" },
            { value: "TEACHING", label: "Teaching" },
            { value: "NON_TEACHING", label: "Non-teaching" },
          ]}
        />
        <SelectField
          label="Show"
          value={status}
          onChange={(e) => (setStatus(e.target.value), setPage(1))}
          options={[
            { value: "live", label: "Current staff" },
            { value: "archived", label: "Archived" },
            { value: "all", label: "Everyone" },
          ]}
        />
      </div>

      <p ref={summaryRef} tabIndex={-1} className="text-sm text-fg-muted focus:outline-none" aria-live="polite">
        {meta ? `${meta.total} ${meta.total === 1 ? "person" : "people"}` : " "}
      </p>
      <ListState
        loading={loading}
        error={error}
        empty={staff.length === 0}
        emptyText={filtered ? "Nobody matches these filters." : canEdit ? "No staff yet. Add the first member of staff." : "No staff yet."}
        onRetry={() => void reload()}
      >
        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <div
            aria-hidden="true"
            className={`hidden border-b border-line bg-surface-2 px-4 py-2.5 text-xs font-semibold tracking-wide text-fg-muted uppercase ${ROW}`}
          >
            <span>Name</span>
            <span>Kind</span>
            <span>Campus</span>
            <span>Sign-in</span>
          </div>
          <ul className="divide-y divide-line">
            {staff.map((person) => (
              <li key={person.id} className={`flex flex-col gap-1 p-4 ${ROW}`}>
                <p className="min-w-0 text-sm font-semibold break-words text-fg">
                  <Link
                    href={`/schools/${schoolCode}/people/staff/${person.id}`}
                    className={`inline-flex min-h-11 items-center rounded underline-offset-4 hover:underline ${FOCUS_RING}`}
                  >
                    {fullName(person)}
                  </Link>{" "}
                  {person.archived && <StatusPill tone="neutral">Archived</StatusPill>}
                  {person.email && <span className="block text-xs font-normal text-fg-muted">{person.email}</span>}
                </p>
                <p className="text-sm text-fg-2">{CATEGORY_LABEL[person.category]}</p>
                <p className="text-sm text-fg-2">{person.campusName ?? "Whole school"}</p>
                <p>
                  <AccountPill account={person.account} />
                </p>
              </li>
            ))}
          </ul>
        </div>
      </ListState>
      <Pager meta={meta} label="Pages of staff" onPage={setPage} />

      {form.n > 0 && (
        <StaffFormDialog
          key={`form-${form.n}`}
          open={form.open}
          onClose={form.hide}
          schoolCode={schoolCode}
          campuses={campuses}
          staff={null}
          onDone={done(form.hide, (answer) => {
            const created = answer.data?.staff as StaffView | undefined;
            return created ? `Added ${fullName(created)}.` : "Staff member added.";
          })}
        />
      )}
    </section>
  );
}
