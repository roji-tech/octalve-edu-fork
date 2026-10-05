"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { SelectField } from "@/components/ui/SelectField";
import { TextField } from "@/components/ui/TextField";
import { PlusIcon } from "@/components/ui/icons";
import { NETWORK_ERROR, RATE_LIMITED, SESSION_ENDED, getJson, sendJson } from "@/components/auth/postJson";
import { initialsOf } from "@/components/shell/nav";
import { ROLE_LABELS } from "@/lib/roles";
import { DeactivateDialog } from "./DeactivateDialog";
import { EditMemberDialog } from "./EditMemberDialog";
import { InvitationsList } from "./InvitationsList";
import { InviteDialog } from "./InviteDialog";
import { ROLE_OPTIONS, displayName, type CampusOption, type Invitation, type Member, type PageMeta } from "./model";

const PAGE_SIZE = 20;
const ROW = "md:grid md:grid-cols-[minmax(0,2.2fr)_9rem_minmax(0,1.2fr)_6.5rem_auto] md:items-center md:gap-4";

type Notice = { variant: "success" | "error"; text: string } | null;

const failureText = (status: number, message?: string) =>
  status === 401 ? SESSION_ENDED : status === 429 ? RATE_LIMITED : status === 0 ? NETWORK_ERROR : (message ?? "That didn't work. Please try again in a moment.");

/// The Users page (plan §0.5.4): the school's people with filters and paging, the open invitations, and the four things an administrator does —
/// invite, change role/campus, deactivate, reactivate. Everything goes through the API (which enforces who may do what); this only shows the
/// answer. Results are announced in one polite live region, and focus is never left on a control that has just disappeared.
export function UsersPanel({ schoolCode, schoolName, campuses, currentUserId }: { schoolCode: string; schoolName: string; campuses: CampusOption[]; currentUserId: string }) {
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("active");
  const [campusId, setCampusId] = useState("");
  const [page, setPage] = useState(1);

  const [members, setMembers] = useState<Member[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);

  const [notice, setNotice] = useState<Notice>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteKey, setInviteKey] = useState(0);
  const [editing, setEditing] = useState<Member | null>(null);
  const [deactivating, setDeactivating] = useState<Member | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [busyInvitation, setBusyInvitation] = useState<string | null>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);

  // The search box waits for a pause in typing before it asks the server. Only when the text really changed: on mount (and on any
  // re-run with the same text) there is nothing to apply, and resetting the page then would undo a click on "Next" made within 300 ms.
  useEffect(() => {
    if (searchText.trim() === q) return;
    const timer = setTimeout(() => {
      setQ(searchText.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, q]);

  // The two lists load through plain functions, so an action can AWAIT its own refresh (and, with `flush`, have the new lists in the DOM
  // when it resumes) instead of guessing with a timer how long the refresh takes.
  const loadMembers = useCallback(
    async (signal?: AbortSignal, flush = false) => {
      const params = new URLSearchParams({ status, page: String(page), limit: String(PAGE_SIZE) });
      if (role) params.set("role", role);
      if (campusId) params.set("campusId", campusId);
      if (q) params.set("q", q);
      const reply = await getJson(`/api/v1/schools/${schoolCode}/members?${params}`, signal);
      if (signal?.aborted) return;
      const apply = () => {
        if (reply.ok) {
          setMembers(reply.data!.members as Member[]);
          setMeta(reply.meta as PageMeta);
          setLoadError(null);
        } else {
          setLoadError(failureText(reply.status, reply.message));
        }
      };
      if (flush) flushSync(apply);
      else apply();
    },
    [schoolCode, status, role, campusId, q, page],
  );
  const loadInvitations = useCallback(
    async (signal?: AbortSignal, flush = false) => {
      const reply = await getJson(`/api/v1/schools/${schoolCode}/invitations?limit=100`, signal);
      if (signal?.aborted || !reply.ok) return;
      const apply = () => setInvitations(reply.data!.invitations as Invitation[]);
      if (flush) flushSync(apply);
      else apply();
    },
    [schoolCode],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadMembers(controller.signal);
    return () => controller.abort();
  }, [loadMembers]);
  useEffect(() => {
    const controller = new AbortController();
    void loadInvitations(controller.signal);
    return () => controller.abort();
  }, [loadInvitations]);

  /// Reloads both lists and resolves when they are in the DOM.
  const refresh = useCallback(() => Promise.all([loadMembers(undefined, true), loadInvitations(undefined, true)]).then(() => undefined), [loadMembers, loadInvitations]);

  /// After a change that may have removed the control that had focus (a deactivated person's row, a revoked invitation, the closed dialog's
  /// opener): wait until the lists are refreshed — and in the DOM — and only then, if focus has fallen to <body>, park it on the page summary.
  /// No timer: whatever the machine's speed, the check happens after the thing it is checking for.
  async function afterChange() {
    await refresh();
    if (!document.activeElement || document.activeElement === document.body) summaryRef.current?.focus();
  }

  async function reactivate(member: Member) {
    setBusyUser(member.userId);
    const reply = await sendJson(`/api/v1/schools/${schoolCode}/members/${member.userId}/reactivate`, "POST", {});
    setBusyUser(null);
    if (reply.ok) {
      setNotice({ variant: "success", text: `${displayName(member)} can use ${schoolName} again.` });
      await afterChange();
    } else {
      setNotice({ variant: "error", text: failureText(reply.status, reply.message) });
    }
  }

  async function resend(invitation: Invitation) {
    setBusyInvitation(invitation.id);
    const reply = await sendJson(`/api/v1/schools/${schoolCode}/invitations/${invitation.id}/resend`, "POST", {});
    setBusyInvitation(null);
    if (reply.ok) {
      setNotice({ variant: "success", text: `A new invitation was sent to ${invitation.email}. The earlier link no longer works.` });
      await refresh();
    } else if (reply.status === 404) {
      setNotice({ variant: "error", text: "That invitation is no longer open." });
      await refresh();
    } else {
      setNotice({ variant: "error", text: failureText(reply.status, reply.message) });
    }
  }

  async function revoke(invitation: Invitation) {
    setBusyInvitation(invitation.id);
    const reply = await sendJson(`/api/v1/schools/${schoolCode}/invitations/${invitation.id}`, "DELETE");
    setBusyInvitation(null);
    if (reply.ok || reply.status === 404) {
      setNotice({ variant: "success", text: `The invitation to ${invitation.email} was revoked. Its link no longer works.` });
      await afterChange();
    } else {
      setNotice({ variant: "error", text: failureText(reply.status, reply.message) });
    }
  }

  const filtered = Boolean(q || role || campusId || status !== "active");
  const clearFilters = () => {
    setSearchText("");
    setQ("");
    setRole("");
    setCampusId("");
    setStatus("active");
    setPage(1);
  };

  return (
    <div className="mt-8 space-y-10">
      <div role="status" aria-live="polite" className="empty:hidden">
        {notice && notice.variant === "success" && <Alert variant="success" announce={false}>{notice.text}</Alert>}
      </div>
      {notice && notice.variant === "error" && <Alert variant="error">{notice.text}</Alert>}

      <section aria-labelledby="people-heading">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <h2 id="people-heading" className="text-lg font-semibold tracking-tight text-fg">
            People
          </h2>
          <Button
            onClick={() => {
              setNotice(null);
              setInviteKey((k) => k + 1);
              setInviting(true);
            }}
          >
            <PlusIcon className="h-4 w-4" />
            Invite someone
          </Button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TextField label="Search" type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Name or email" autoComplete="off" maxLength={64} />
          <SelectField label="Role" value={role} onChange={(e) => (setRole(e.target.value), setPage(1))} options={[{ value: "", label: "All roles" }, ...ROLE_OPTIONS]} />
          <SelectField label="Campus" value={campusId} onChange={(e) => (setCampusId(e.target.value), setPage(1))} options={[{ value: "", label: "All campuses" }, ...campuses.map((c) => ({ value: c.id, label: c.name }))]} />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => (setStatus(e.target.value), setPage(1))}
            options={[
              { value: "active", label: "Active" },
              { value: "deactivated", label: "Deactivated" },
              { value: "all", label: "Everyone" },
            ]}
          />
        </div>

        <p ref={summaryRef} tabIndex={-1} className="mt-4 text-sm text-fg-muted focus:outline-none" aria-live="polite">
          {meta ? `${meta.total} ${meta.total === 1 ? "person" : "people"}${filtered ? " match" : ""}` : " "}
        </p>

        {loadError ? (
          <Alert variant="error" className="mt-3">
            <p>{loadError}</p>
            <Button variant="secondary" className="mt-3" onClick={() => void refresh()}>
              Try again
            </Button>
          </Alert>
        ) : members === null ? (
          <p className="mt-3 rounded-2xl border border-line bg-surface p-6 text-sm text-fg-muted" aria-busy="true">
            Loading people…
          </p>
        ) : members.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-dashed border-line-strong p-8 text-center text-sm text-fg-muted">
            <p>{filtered ? "No one matches these filters." : "No one has joined yet."}</p>
            {filtered && (
              <Button variant="secondary" className="mt-4" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-3 overflow-hidden rounded-2xl border border-line bg-surface">
            <div aria-hidden="true" className={`hidden border-b border-line bg-surface-2 px-4 py-2.5 text-xs font-semibold tracking-wide text-fg-muted uppercase ${ROW}`}>
              <span>Person</span>
              <span>Role</span>
              <span>Campus</span>
              <span>Status</span>
              <span className="w-64 text-right">Actions</span>
            </div>
            <ul className="divide-y divide-line">
              {members.map((member) => {
                const name = displayName(member);
                const self = member.userId === currentUserId;
                const busy = busyUser === member.userId;
                return (
                  <li key={member.userId} className={`flex flex-col gap-3 p-4 ${ROW}`}>
                    <div className="flex min-w-0 items-center gap-3">
                      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-bold text-brand-fg">
                        {initialsOf(member.name, member.email)}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold break-words text-fg">
                          {name}
                          {self && <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-fg-muted">You</span>}
                        </p>
                        {member.name?.trim() && member.email && <p className="text-xs break-all text-fg-muted">{member.email}</p>}
                      </div>
                    </div>
                    <p className="text-sm text-fg-2">
                      <span className="text-xs font-semibold tracking-wide text-fg-muted uppercase md:hidden">Role: </span>
                      {ROLE_LABELS[member.role]}
                    </p>
                    <p className="text-sm text-fg-2">
                      <span className="text-xs font-semibold tracking-wide text-fg-muted uppercase md:hidden">Campus: </span>
                      {member.role === "ADMIN" && !member.campusName ? "All campuses" : (member.campusName ?? "None")}
                    </p>
                    <p>
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${member.status === "active" ? "bg-ok-bg text-ok-fg" : "bg-warn-bg text-warn-fg"}`}
                      >
                        {member.status === "active" ? "Active" : "Deactivated"}
                      </span>
                    </p>
                    <div className="flex gap-2 md:w-64 md:justify-end">
                      {self ? null : member.status === "active" ? (
                        <>
                          <Button variant="secondary" className="flex-1 md:flex-none" onClick={() => setEditing(member)} aria-label={`Change role or campus for ${name}`}>
                            Edit
                          </Button>
                          <Button variant="ghost" className="flex-1 md:flex-none" onClick={() => setDeactivating(member)} aria-label={`Deactivate ${name}`}>
                            Deactivate
                          </Button>
                        </>
                      ) : (
                        <Button variant="secondary" className="flex-1 md:flex-none" loading={busy} onClick={() => reactivate(member)} aria-label={`Reactivate ${name}`}>
                          Reactivate
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {meta && meta.pages > 1 && (
          <nav aria-label="Pages of people" className="mt-4 flex items-center justify-between gap-3">
            <Button variant="secondary" disabled={meta.page <= 1} onClick={() => setPage(meta.page - 1)}>
              Previous
            </Button>
            <p className="text-sm text-fg-muted">
              Page {meta.page} of {meta.pages}
            </p>
            <Button variant="secondary" disabled={!meta.hasNext} onClick={() => setPage(meta.page + 1)}>
              Next
            </Button>
          </nav>
        )}
      </section>

      <section aria-labelledby="invitations-heading">
        <h2 id="invitations-heading" className="text-lg font-semibold tracking-tight text-fg">
          Pending invitations
        </h2>
        {invitations === null ? (
          <p className="mt-3 text-sm text-fg-muted" aria-busy="true">
            Loading invitations…
          </p>
        ) : invitations.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-line-strong p-6 text-center text-sm text-fg-muted">No invitations are waiting. People you invite appear here until they accept.</p>
        ) : (
          <div className="mt-3">
            <InvitationsList invitations={invitations} busyId={busyInvitation} onResend={resend} onRevoke={revoke} />
          </div>
        )}
      </section>

      <InviteDialog
        key={inviteKey}
        open={inviting}
        onClose={() => setInviting(false)}
        schoolCode={schoolCode}
        campuses={campuses}
        onInvited={(invitation) => {
          flushSync(() => setInviting(false)); // the dialog is closed (and focus handed back) before the lists are reloaded
          setNotice({ variant: "success", text: `Invitation sent to ${invitation.email}. The link works for 7 days.` });
          void afterChange();
        }}
      />
      <EditMemberDialog
        member={editing}
        onClose={() => setEditing(null)}
        schoolCode={schoolCode}
        campuses={campuses}
        onSaved={(member, changed) => {
          flushSync(() => setEditing(null));
          setNotice({ variant: "success", text: changed ? `Saved. ${displayName(member)} is now ${ROLE_LABELS[member.role]}${member.campusName ? ` at ${member.campusName}` : ""}.` : "Nothing needed changing." });
          void refresh();
        }}
      />
      <DeactivateDialog
        member={deactivating}
        onClose={() => setDeactivating(null)}
        schoolCode={schoolCode}
        schoolName={schoolName}
        onDone={(member) => {
          flushSync(() => setDeactivating(null)); // the dialog is closed (and focus handed back) before the lists are reloaded
          setNotice({ variant: "success", text: `${displayName(member)} was deactivated. They lose access on their next request.` });
          void afterChange();
        }}
      />
    </div>
  );
}
