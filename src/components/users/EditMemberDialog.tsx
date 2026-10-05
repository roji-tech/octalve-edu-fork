"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SelectField } from "@/components/ui/SelectField";
import { NETWORK_ERROR, RATE_LIMITED, SESSION_ENDED, problemFor, sendJson } from "@/components/auth/postJson";
import { ROLE_OPTIONS, displayName, type CampusOption, type Member, type RoleName } from "./model";

/// Change one person's role and/or campus. Only what changed is sent. The server enforces the authority rules (not yourself, never the
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
    <Dialog open={member !== null} onClose={onClose} title={member ? `Change access for ${displayName(member)}` : "Change access"} description="Takes effect on their next request.">
      {member && <EditForm key={member.userId} member={member} onClose={onClose} schoolCode={schoolCode} campuses={campuses} onSaved={onSaved} />}
    </Dialog>
  );
}

function EditForm({ member, onClose, schoolCode, campuses, onSaved }: { member: Member; onClose: () => void; schoolCode: string; campuses: CampusOption[]; onSaved: (member: Member, changed: boolean) => void }) {
  const [role, setRole] = useState<RoleName>(member.role);
  const [campusId, setCampusId] = useState(member.campusId ?? "");
  const [campusError, setCampusError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    setCampusError(null);
    const body: { role?: RoleName; campusId?: string | null } = {};
    if (role !== member.role) body.role = role;
    if (campusId !== (member.campusId ?? "")) body.campusId = campusId || null;
    if (Object.keys(body).length === 0) return onClose(); // nothing changed — nothing sent

    setPending(true);
    const reply = await sendJson(`/api/v1/schools/${schoolCode}/members/${member.userId}`, "PATCH", body);
    setPending(false);
    if (reply.ok) return onSaved(reply.data!.member as Member, Boolean(reply.data!.changed));

    const campusProblem = problemFor(reply, "campusId");
    if (campusProblem) setCampusError(campusProblem);
    else if (reply.status === 401) setFormError(SESSION_ENDED);
    else if (reply.status === 429) setFormError(RATE_LIMITED);
    else if (reply.status === 0) setFormError(NETWORK_ERROR);
    else setFormError(reply.message ?? "We couldn't save that change. Please try again.");
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <SelectField label="Role" name="role" value={role} onChange={(e) => setRole(e.target.value as RoleName)} options={ROLE_OPTIONS} disabled={pending} />
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
