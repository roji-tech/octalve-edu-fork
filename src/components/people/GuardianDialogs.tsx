"use client";

import { useEffect, useState } from "react";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { SelectField } from "@/components/ui/SelectField";
import { TextField } from "@/components/ui/TextField";
import { sendJson, type Reply } from "@/components/auth/postJson";
import { ConfirmDialog, FormDialog, type Outcome } from "@/components/academics/parts";
import { useApi } from "@/components/academics/useApi";
import { RELATIONSHIP_OPTIONS, fullName, type GuardianLinkView, type GuardianView, type StudentView } from "./model";

const base = (schoolCode: string) => `/api/v1/schools/${schoolCode}`;
const blankToNull = (text: string) => (text.trim() === "" ? null : text.trim());

/// Adding a guardian to a student: a NEW person (name and contact), or someone already in the register — a sibling's parent is one record, not two.
export function AddGuardianDialog({
  open,
  onClose,
  schoolCode,
  student,
  hasGuardians,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  student: StudentView;
  hasGuardians: boolean;
  onDone: (reply: Reply) => void;
}) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [guardianId, setGuardianId] = useState("");
  const [relationship, setRelationship] = useState("MOTHER");
  const [isPrimary, setIsPrimary] = useState(false);

  useEffect(() => {
    if (searchText.trim() === q) return;
    const timer = setTimeout(() => setQ(searchText.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchText, q]);
  const found = useApi(
    mode === "existing" && q.length >= 2 ? `${base(schoolCode)}/people/guardians?q=${encodeURIComponent(q)}&limit=20` : null,
  );
  const guardians = (found.reply?.data?.guardians as GuardianView[] | undefined) ?? [];

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (mode === "new") {
      if (!firstName.trim()) errors.firstName = "Give the guardian's first name.";
      if (!lastName.trim()) errors.lastName = "Give the guardian's last name.";
    } else if (!guardianId) {
      errors.guardianId = "Search for the guardian, then choose them.";
    }
    if (Object.keys(errors).length > 0) return { errors };
    return sendJson(`${base(schoolCode)}/people/students/${student.id}/guardians`, "POST", {
      relationship,
      ...(isPrimary ? { isPrimary: true } : {}),
      ...(mode === "existing"
        ? { guardianId }
        : { firstName: firstName.trim(), lastName: lastName.trim(), phone: blankToNull(phone), email: blankToNull(email) }),
    });
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Add a guardian for ${fullName(student)}`}
      description={hasGuardians ? undefined : "The first guardian you add becomes the primary contact."}
      submitLabel="Add guardian"
      pendingLabel="Adding…"
      fields={["guardianId", "firstName", "lastName", "phone", "email", "relationship", "isPrimary"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <SelectField
            label="Who is it?"
            value={mode}
            onChange={(e) => setMode(e.target.value as "new" | "existing")}
            disabled={pending}
            options={[
              { value: "new", label: "A new person" },
              { value: "existing", label: "Someone already in the register" },
            ]}
          />
          {mode === "new" ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="First name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  error={errors.firstName}
                  maxLength={80}
                  autoComplete="off"
                  disabled={pending}
                />
                <TextField
                  label="Last name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  error={errors.lastName}
                  maxLength={80}
                  autoComplete="off"
                  disabled={pending}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Phone (optional)"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  error={errors.phone}
                  maxLength={20}
                  autoComplete="off"
                  disabled={pending}
                />
                <TextField
                  label="Email (optional)"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  error={errors.email}
                  maxLength={254}
                  autoComplete="off"
                  disabled={pending}
                />
              </div>
            </>
          ) : (
            <>
              <TextField
                label="Search guardians"
                type="search"
                value={searchText}
                onChange={(e) => (setSearchText(e.target.value), setGuardianId(""))}
                hint="Type at least two letters of a name, phone number or email."
                maxLength={100}
                autoComplete="off"
                disabled={pending}
              />
              <SelectField
                label="Guardian"
                value={guardianId}
                onChange={(e) => setGuardianId(e.target.value)}
                error={errors.guardianId}
                disabled={pending || guardians.length === 0}
                options={[
                  {
                    value: "",
                    label:
                      q.length < 2 ? "Search first…" : guardians.length === 0 ? (found.loading ? "Searching…" : "Nobody found") : "Choose…",
                  },
                  ...guardians.map((g) => ({
                    value: g.id,
                    label: `${g.firstName} ${g.lastName}${g.phone ? ` · ${g.phone}` : ""}${g.email ? ` · ${g.email}` : ""}`,
                  })),
                ]}
              />
            </>
          )}
          <SelectField
            label="Relationship to the student"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            error={errors.relationship}
            disabled={pending}
            options={RELATIONSHIP_OPTIONS}
          />
          {hasGuardians && (
            <CheckboxField
              label="Make this the primary contact"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
              disabled={pending}
            />
          )}
        </>
      )}
    </FormDialog>
  );
}

/// Changing how a guardian is related, or who the primary contact is. (Their name and phone are edited on the guardian, not the link.)
export function EditLinkDialog({
  open,
  onClose,
  schoolCode,
  student,
  link,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  student: StudentView;
  link: GuardianLinkView;
  onDone: (reply: Reply) => void;
}) {
  const [relationship, setRelationship] = useState<string>(link.relationship);
  const [isPrimary, setIsPrimary] = useState(link.isPrimary);
  const [firstName, setFirstName] = useState(link.guardian.firstName);
  const [lastName, setLastName] = useState(link.guardian.lastName);
  const [phone, setPhone] = useState(link.guardian.phone ?? "");
  const [email, setEmail] = useState(link.guardian.email ?? "");

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!firstName.trim()) errors.firstName = "Give the guardian's first name.";
    if (!lastName.trim()) errors.lastName = "Give the guardian's last name.";
    if (Object.keys(errors).length > 0) return { errors };
    // The guardian's own details first (they belong to the person, so they change for every child), then how this child relates to them.
    const person = await sendJson(`${base(schoolCode)}/people/guardians/${link.guardian.id}`, "PATCH", {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: blankToNull(phone),
      email: blankToNull(email),
    });
    if (!person.ok) return person;
    return sendJson(`${base(schoolCode)}/people/students/${student.id}/guardians/${link.id}`, "PATCH", { relationship, isPrimary });
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Edit ${link.guardian.firstName} ${link.guardian.lastName}`}
      description={
        link.guardian.studentCount > 1
          ? `Name and contact details are shared with their other ${link.guardian.studentCount - 1 === 1 ? "child" : "children"} at the school; the relationship is just for ${fullName(student)}.`
          : undefined
      }
      submitLabel="Save changes"
      pendingLabel="Saving…"
      fields={["firstName", "lastName", "phone", "email", "relationship", "isPrimary"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="First name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              error={errors.firstName}
              maxLength={80}
              autoComplete="off"
              disabled={pending}
            />
            <TextField
              label="Last name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              error={errors.lastName}
              maxLength={80}
              autoComplete="off"
              disabled={pending}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Phone (optional)"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              error={errors.phone}
              maxLength={20}
              autoComplete="off"
              disabled={pending}
            />
            <TextField
              label="Email (optional)"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={errors.email}
              maxLength={254}
              autoComplete="off"
              disabled={pending}
            />
          </div>
          <SelectField
            label="Relationship to the student"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            error={errors.relationship}
            disabled={pending}
            options={RELATIONSHIP_OPTIONS}
          />
          <CheckboxField label="Primary contact" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} disabled={pending} />
        </>
      )}
    </FormDialog>
  );
}

export function RemoveGuardianDialog({
  open,
  onClose,
  schoolCode,
  student,
  link,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  student: StudentView;
  link: GuardianLinkView;
  onDone: (reply: Reply) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Remove ${link.guardian.firstName} ${link.guardian.lastName}?`}
      confirmLabel="Remove guardian"
      pendingLabel="Removing…"
      danger
      onConfirm={() => sendJson(`${base(schoolCode)}/people/students/${student.id}/guardians/${link.id}/remove`, "POST")}
      onDone={onDone}
    >
      <p>
        They are no longer {fullName(student)}&apos;s guardian
        {link.isPrimary ? ", and the student will have no primary contact until you choose one" : ""}. Their record
        {link.guardian.studentCount > 1 ? " stays, still linked to their other children" : " stays in the register"}, and you can add them
        again later.
      </p>
    </ConfirmDialog>
  );
}
