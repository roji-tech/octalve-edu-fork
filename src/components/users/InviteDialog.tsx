"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SelectField } from "@/components/ui/SelectField";
import { TextField } from "@/components/ui/TextField";
import { NETWORK_ERROR, RATE_LIMITED, SESSION_ENDED, problemFor, sendJson } from "@/components/auth/postJson";
import { ROLE_OPTIONS, type CampusOption, type Invitation, type RoleName } from "./model";

/// "Invite someone": an address, a role and (optionally) a campus. The server checks everything again; this form only gives the answer where
/// the person is looking. The dialog is remounted per opening (the owner keys it), so it always starts clean.
export function InviteDialog({
  open,
  onClose,
  schoolCode,
  campuses,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  campuses: CampusOption[];
  onInvited: (invitation: Invitation) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleName>("TEACHING_STAFF");
  const [campusId, setCampusId] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const address = email.trim();
    if (!address) return setEmailError("Enter an email address.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return setEmailError("Enter a valid email address.");
    setEmailError(null);

    setPending(true);
    const reply = await sendJson(`/api/v1/schools/${schoolCode}/invitations`, "POST", { email: address, role, campusId: campusId || null });
    setPending(false);
    if (reply.ok) return onInvited(reply.data!.invitation as Invitation);

    const emailProblem = problemFor(reply, "email");
    if (emailProblem) setEmailError(emailProblem);
    else if (reply.status === 401) setFormError(SESSION_ENDED);
    else if (reply.status === 429) setFormError(reply.message ?? RATE_LIMITED);
    else if (reply.status === 0) setFormError(NETWORK_ERROR);
    else setFormError(problemFor(reply, "campusId") ?? reply.message ?? "We couldn't send that invitation. Please try again.");
  }

  return (
    <Dialog open={open} onClose={onClose} title="Invite someone" description="They get an email with a link that works for 7 days. Until they accept, they have no access.">
      <form onSubmit={submit} noValidate className="space-y-4">
        <TextField
          label="Email address"
          type="email"
          name="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (emailError) setEmailError(null);
          }}
          error={emailError}
          autoComplete="off"
          inputMode="email"
          maxLength={254}
          autoFocus
          disabled={pending}
        />
        <SelectField label="Role" name="role" value={role} onChange={(e) => setRole(e.target.value as RoleName)} options={ROLE_OPTIONS} disabled={pending} />
        <SelectField
          label="Campus"
          name="campus"
          value={campusId}
          onChange={(e) => setCampusId(e.target.value)}
          options={[{ value: "", label: "No specific campus" }, ...campuses.map((c) => ({ value: c.id, label: c.name }))]}
          hint={role === "ADMIN" ? "Administrators can see every campus whatever is chosen here." : "Everyone else sees only their own campus."}
          disabled={pending}
        />
        {formError && <Alert variant="error">{formError}</Alert>}
        <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {pending ? "Sending…" : "Send invitation"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
