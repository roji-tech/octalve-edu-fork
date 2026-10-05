"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { PencilIcon } from "@/components/ui/icons";
import { checkName, NAME_MAX_LENGTH } from "@/lib/auth/profile-policy";
import { GENERIC_ERROR, NETWORK_ERROR, RATE_LIMITED, SESSION_ENDED, sendJson } from "@/components/auth/postJson";

/// "Profile" card of the account page (plan §0.5.E): the person's name, editable in place. The email is shown
/// but changed through its own card — it needs the password and a link to the new address. The name is checked
/// here with the same rule the server uses (checkName), so the feedback is immediate and the server's answer
/// is only ever a backstop.
export function ProfileDetails({ name, email }: { name: string | null; email: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  const [shown, setShown] = useState(name?.trim() || "");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  // The Edit button reappears where the field was; once it is on screen, put focus back on it rather than on
  // <body>. (An effect, not a timer: after an awaited save React commits on its own schedule, not before a 0 ms timeout.)
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  function startEditing() {
    setDraft(shown);
    setError(null);
    setFormError(null);
    setSaved(false);
    setEditing(true);
  }

  function stopEditing() {
    returnFocus.current = true;
    setEditing(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const checked = checkName(draft);
    if (!checked.ok) return setError(checked.message);
    setError(null);

    if (checked.name === shown) return stopEditing(); // nothing changed — don't write, don't audit

    setPending(true);
    const reply = await sendJson("/api/v1/account/profile", "PATCH", { name: checked.name });
    setPending(false);
    if (reply.ok) {
      setShown(checked.name);
      setSaved(true);
      stopEditing();
      router.refresh(); // the header shows the name too
    } else if (reply.code === "VALIDATION") setError(reply.message ?? GENERIC_ERROR);
    else if (reply.status === 429) setFormError(RATE_LIMITED);
    else if (reply.status === 401) setFormError(SESSION_ENDED);
    else setFormError(reply.code === "NETWORK" ? NETWORK_ERROR : GENERIC_ERROR);
  }

  return (
    <div className="mt-4 space-y-4">
      {saved && !editing && <Alert variant="success">Name updated.</Alert>}
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          {/* While editing, the field's own label says "Name"; the term stays for screen readers only. */}
          <dt className={editing ? "sr-only" : "text-xs font-semibold tracking-wide text-fg-muted uppercase"}>Name</dt>
          {editing ? (
            <dd>
              <form method="post" onSubmit={submit} noValidate className="space-y-3" aria-label="Edit your name">
                <TextField
                  label="Name"
                  name="name"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (error) setError(null);
                  }}
                  error={error}
                  autoComplete="name"
                  autoFocus
                  maxLength={NAME_MAX_LENGTH * 4}
                  disabled={pending}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && !pending) stopEditing();
                  }}
                />
                {formError && <Alert variant="error">{formError}</Alert>}
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" loading={pending}>
                    {pending ? "Saving…" : "Save"}
                  </Button>
                  <Button variant="ghost" onClick={stopEditing} disabled={pending}>
                    Cancel
                  </Button>
                </div>
              </form>
            </dd>
          ) : (
            <dd className="mt-1 flex items-center gap-2">
              <span className="min-w-0 truncate text-sm text-fg" data-testid="profile-name">
                {shown || "—"}
              </span>
              <Button
                variant="ghost"
                onClick={startEditing}
                className="!min-h-11 !px-3 !py-2"
                aria-label={shown ? `Edit name (currently ${shown})` : "Add your name"}
                ref={editButton}
              >
                <PencilIcon className="h-4 w-4" />
                {shown ? "Edit" : "Add"}
              </Button>
            </dd>
          )}
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Email</dt>
          <dd className="mt-1 truncate text-sm text-fg">{email ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}
