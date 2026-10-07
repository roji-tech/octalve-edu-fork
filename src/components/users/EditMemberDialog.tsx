"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SelectField } from "@/components/ui/SelectField";
import { NETWORK_ERROR, RATE_LIMITED, SESSION_ENDED, problemFor, sendJson } from "@/components/auth/postJson";
import { CheckboxField } from "@/components/ui/CheckboxField";
import {
  PERMISSION_OPTIONS,
  ROLE_OPTIONS,
  canHoldPermissions,
  displayName,
  type CampusOption,
  type Member,
  type PermissionName,
  type RoleName,
} from "./model";

/// Change one person's role, campus and/or extra permissions. Only what changed is sent. The server enforces the authority rules (not yourself, never the
/// school's last administrator, a campus of this school) and its message is shown as it is — those are the cases a person can act on.
export function EditMemberDialog({
  member,
  onClose,
  schoolCode,
  campuses,
  onSaved,
}: {
  member: Member | null;
  onClose: () => void;
  schoolCode: string;
  campuses: CampusOption[];
  onSaved: (member: Member, changed: boolean) => void;
}) {
  return (
    <Dialog
      open={member !== null}
      onClose={onClose}
      title={member ? `Change access for ${displayName(member)}` : "Change access"}
      description="Takes effect on their next request."
    >
      {member && (
        <EditForm key={member.userId} member={member} onClose={onClose} schoolCode={schoolCode} campuses={campuses} onSaved={onSaved} />
      )}
    </Dialog>
  );
}

function EditForm({
  member,
  onClose,
  schoolCode,
  campuses,
  onSaved,
}: {
  member: Member;
  onClose: () => void;
  schoolCode: string;
  campuses: CampusOption[];
  onSaved: (member: Member, changed: boolean) => void;
}) {
  const [role, setRole] = useState<RoleName>(member.role);
  const [campusId, setCampusId] = useState(member.campusId ?? "");
  const [permissions, setPermissions] = useState<PermissionName[]>(member.permissions);
  const [campusError, setCampusError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const staff = canHoldPermissions(role);
  const willLose = !staff && member.permissions.length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    setCampusError(null);
    const body: { role?: RoleName; campusId?: string | null; permissions?: PermissionName[] } = {};
    if (role !== member.role) body.role = role;
    if (campusId !== (member.campusId ?? "")) body.campusId = campusId || null;
    // Sent only for a role that can hold them, and only when the set changed; moving to a role that cannot clears them on the server.
    if (staff && (permissions.length !== member.permissions.length || permissions.some((p) => !member.permissions.includes(p)))) {
      body.permissions = PERMISSION_OPTIONS.map((option) => option.value).filter((value) => permissions.includes(value));
    }
    if (Object.keys(body).length === 0) return onClose(); // nothing changed — nothing sent

    setPending(true);
    const reply = await sendJson(`/api/v1/schools/${schoolCode}/members/${member.userId}`, "PATCH", body);
    setPending(false);
    if (reply.ok) return onSaved(reply.data!.member as Member, Boolean(reply.data!.changed));

    const campusProblem = problemFor(reply, "campusId");
    const permissionsProblem = problemFor(reply, "permissions");
    if (campusProblem) setCampusError(campusProblem);
    else if (permissionsProblem) setFormError(permissionsProblem);
    else if (reply.status === 401) setFormError(SESSION_ENDED);
    else if (reply.status === 429) setFormError(RATE_LIMITED);
    else if (reply.status === 0) setFormError(NETWORK_ERROR);
    else setFormError(reply.message ?? "We couldn't save that change. Please try again.");
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <SelectField
        label="Role"
        name="role"
        value={role}
        onChange={(e) => setRole(e.target.value as RoleName)}
        options={ROLE_OPTIONS}
        disabled={pending}
      />
      <SelectField
        label="Campus"
        name="campus"
        value={campusId}
        onChange={(e) => {
          setCampusId(e.target.value);
          setCampusError(null);
        }}
        options={[{ value: "", label: "No specific campus" }, ...campuses.map((c) => ({ value: c.id, label: c.name }))]}
        error={campusError}
        disabled={pending}
      />
      {staff ? (
        <fieldset className="space-y-1" disabled={pending}>
          <legend className="text-sm font-medium text-fg">Extra permissions</legend>
          <p className="text-xs text-fg-muted">Beyond what their role allows. Administrators can do all of these already.</p>
          {PERMISSION_OPTIONS.map((option) => (
            <div key={option.value}>
              <CheckboxField
                name="permissions"
                value={option.value}
                label={option.label}
                checked={permissions.includes(option.value)}
                onChange={(e) =>
                  setPermissions((current) => (e.target.checked ? [...current, option.value] : current.filter((p) => p !== option.value)))
                }
                aria-describedby={`perm-help-${option.value}`}
              />
              <p id={`perm-help-${option.value}`} className="-mt-1 ml-8 text-xs text-fg-muted">
                {option.help}
              </p>
            </div>
          ))}
        </fieldset>
      ) : (
        <p className="text-xs text-fg-muted">
          {role === "ADMIN"
            ? "Administrators can do everything, so extra permissions don't apply."
            : "Extra permissions can only be given to staff."}
          {willLose ? ` Saving will remove the extra permissions ${displayName(member)} has now.` : ""}
        </p>
      )}
      {formError && <Alert variant="error">{formError}</Alert>}
      <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
