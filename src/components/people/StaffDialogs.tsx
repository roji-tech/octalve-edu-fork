"use client";

import { useState } from "react";
import { SelectField } from "@/components/ui/SelectField";
import { TextField } from "@/components/ui/TextField";
import { sendJson, type Reply } from "@/components/auth/postJson";
import { ConfirmDialog, FormDialog, type Outcome } from "@/components/academics/parts";
import { useApi } from "@/components/academics/useApi";
import type { SubjectView } from "@/components/academics/model";
import { useEnrolmentChoices } from "./StudentDialogs";
import { CATEGORY_LABEL, fullName, type AssignmentView, type CampusOption, type StaffView } from "./model";

const base = (schoolCode: string) => `/api/v1/schools/${schoolCode}`;
const blankToNull = (text: string) => (text.trim() === "" ? null : text.trim());
const CATEGORY_OPTIONS = [
  { value: "TEACHING", label: CATEGORY_LABEL.TEACHING },
  { value: "NON_TEACHING", label: CATEGORY_LABEL.NON_TEACHING },
];

export function StaffFormDialog({
  open,
  onClose,
  schoolCode,
  campuses,
  staff,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  campuses: CampusOption[];
  staff: StaffView | null;
  onDone: (reply: Reply) => void;
}) {
  const [category, setCategory] = useState<string>(staff?.category ?? "TEACHING");
  const [firstName, setFirstName] = useState(staff?.firstName ?? "");
  const [lastName, setLastName] = useState(staff?.lastName ?? "");
  const [phone, setPhone] = useState(staff?.phone ?? "");
  const [email, setEmail] = useState(staff?.email ?? "");
  const [campusId, setCampusId] = useState("");
  const linked = staff?.account.state === "linked";

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!firstName.trim()) errors.firstName = "Give their first name.";
    if (!lastName.trim()) errors.lastName = "Give their last name.";
    if (Object.keys(errors).length > 0) return { errors };
    const person = { firstName: firstName.trim(), lastName: lastName.trim(), phone: blankToNull(phone), email: blankToNull(email) };
    return staff
      ? sendJson(`${base(schoolCode)}/people/staff/${staff.id}`, "PATCH", {
          ...person,
          ...(category !== staff.category ? { category } : {}),
        })
      : sendJson(`${base(schoolCode)}/people/staff`, "POST", { ...person, category, campusId: campusId || null });
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={staff ? `Edit ${fullName(staff)}` : "Add a member of staff"}
      description={staff ? undefined : "A record is how the school knows someone. They only get a sign-in if you invite them afterwards."}
      submitLabel={staff ? "Save changes" : "Add staff member"}
      pendingLabel="Saving…"
      fields={["category", "firstName", "lastName", "phone", "email", "campusId"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <SelectField
            label="Kind of staff"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            error={errors.category}
            hint={linked ? "Fixed while they have a sign-in account." : undefined}
            disabled={pending || linked}
            options={CATEGORY_OPTIONS}
          />
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
              hint="Needed to invite them to sign in."
              maxLength={254}
              autoComplete="off"
              disabled={pending}
            />
          </div>
          {!staff && campuses.length > 0 && (
            <SelectField
              label="Campus"
              value={campusId}
              onChange={(e) => setCampusId(e.target.value)}
              error={errors.campusId}
              hint="Fixed once the record is added."
              disabled={pending}
              options={[{ value: "", label: "Whole school" }, ...campuses.map((campus) => ({ value: campus.id, label: campus.name }))]}
            />
          )}
        </>
      )}
    </FormDialog>
  );
}

export function ArchiveStaffDialog({
  open,
  onClose,
  schoolCode,
  staff,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  staff: StaffView;
  onDone: (reply: Reply) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Archive ${fullName(staff)}?`}
      confirmLabel="Archive record"
      pendingLabel="Archiving…"
      danger
      onConfirm={() => sendJson(`${base(schoolCode)}/people/staff/${staff.id}/archive`, "POST")}
      onDone={onDone}
    >
      <p>
        The record leaves the staff list and can be restored any time. Their sign-in is not touched — to stop someone signing in, deactivate
        them on the Users page. A person who still teaches subjects must have those removed first.
      </p>
    </ConfirmDialog>
  );
}

export function InviteStaffDialog({
  open,
  onClose,
  schoolCode,
  staff,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  staff: StaffView;
  onDone: (reply: Reply) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Invite ${fullName(staff)} to sign in?`}
      confirmLabel="Send invitation"
      pendingLabel="Sending…"
      onConfirm={() => sendJson(`${base(schoolCode)}/people/staff/${staff.id}/invite`, "POST")}
      onDone={onDone}
    >
      <p>
        An email goes to <strong>{staff.email}</strong> with a link that works once, for seven days. They choose their own password, and are
        signed in as {staff.category === "TEACHING" ? "teaching staff" : "non-teaching staff"}
        {staff.campusName ? ` at ${staff.campusName}` : ""}. When they accept, this record is linked to their account.
      </p>
    </ConfirmDialog>
  );
}

export function LinkAccountDialog({
  open,
  onClose,
  schoolCode,
  staff,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  staff: StaffView;
  onDone: (reply: Reply) => void;
}) {
  const choices = useApi(`${base(schoolCode)}/people/staff/${staff.id}/linkable-accounts`);
  const accounts = (choices.reply?.data?.accounts as { userId: string; name: string | null; email: string | null }[] | undefined) ?? [];
  const [userId, setUserId] = useState("");

  async function submit(): Promise<Outcome> {
    if (!userId) return { errors: { userId: "Choose who this record is." } };
    return sendJson(`${base(schoolCode)}/people/staff/${staff.id}/link-account`, "POST", { userId });
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Link ${fullName(staff)} to an account`}
      description={`Choose a member of this school who already signs in as ${staff.category === "TEACHING" ? "teaching staff" : "non-teaching staff"} and has no staff record yet.`}
      submitLabel="Link account"
      pendingLabel="Linking…"
      fields={["userId"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <SelectField
          label="Account"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          error={errors.userId}
          disabled={pending || accounts.length === 0}
          options={[
            { value: "", label: choices.loading ? "Loading…" : accounts.length === 0 ? "Nobody is waiting to be linked" : "Choose…" },
            ...accounts.map((account) => ({
              value: account.userId,
              label: `${account.name ?? "Unnamed"} · ${account.email ?? "no email"}`,
            })),
          ]}
        />
      )}
    </FormDialog>
  );
}

export function UnlinkAccountDialog({
  open,
  onClose,
  schoolCode,
  staff,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  staff: StaffView;
  onDone: (reply: Reply) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Unlink ${fullName(staff)}'s account?`}
      confirmLabel="Unlink account"
      pendingLabel="Unlinking…"
      danger
      onConfirm={() => sendJson(`${base(schoolCode)}/people/staff/${staff.id}/unlink-account`, "POST")}
      onDone={onDone}
    >
      <p>
        The record and the account both stay; they just stop being connected. The person can still sign in — manage that on the Users page.
        You can link them again.
      </p>
    </ConfirmDialog>
  );
}

/// "Teaches this subject to this class." The class must study the subject; the answer says so in words if it does not.
export function AssignDialog({
  open,
  onClose,
  schoolCode,
  staff,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  staff: StaffView;
  onDone: (reply: Reply) => void;
}) {
  const subjects = useApi(`${base(schoolCode)}/academics/subjects?limit=100`);
  const classes = useEnrolmentChoices(schoolCode);
  const subjectList = (subjects.reply?.data?.subjects as SubjectView[] | undefined) ?? [];
  const [subjectId, setSubjectId] = useState("");
  const [classArmId, setClassArmId] = useState("");

  async function submit(): Promise<Outcome> {
    const errors: Record<string, string> = {};
    if (!subjectId) errors.subjectId = "Choose a subject.";
    if (!classArmId) errors.classArmId = "Choose a class.";
    if (Object.keys(errors).length > 0) return { errors };
    return sendJson(`${base(schoolCode)}/people/staff/${staff.id}/assignments`, "POST", { subjectId, classArmId });
  }

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`What does ${fullName(staff)} teach?`}
      description="Choose a subject and the class they teach it to. The class must already study that subject (set that on the Academics page)."
      submitLabel="Add"
      pendingLabel="Adding…"
      fields={["subjectId", "classArmId"]}
      onSubmit={submit}
      onDone={onDone}
    >
      {(errors, pending) => (
        <>
          <SelectField
            label="Subject"
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
            error={errors.subjectId}
            disabled={pending || subjects.loading}
            options={[
              { value: "", label: subjects.loading ? "Loading…" : subjectList.length === 0 ? "No subjects yet" : "Choose a subject…" },
              ...subjectList.map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
          <SelectField
            label="Class"
            value={classArmId}
            onChange={(e) => setClassArmId(e.target.value)}
            error={errors.classArmId}
            disabled={pending || classes.loading}
            options={[
              { value: "", label: classes.loading ? "Loading…" : classes.arms.length === 0 ? "No classes yet" : "Choose a class…" },
              ...classes.arms,
            ]}
          />
        </>
      )}
    </FormDialog>
  );
}

export function RemoveAssignmentDialog({
  open,
  onClose,
  schoolCode,
  staff,
  assignment,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  schoolCode: string;
  staff: StaffView;
  assignment: AssignmentView;
  onDone: (reply: Reply) => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Stop ${assignment.subjectName} in ${assignment.classGroupName} ${assignment.armName}?`}
      confirmLabel="Remove"
      pendingLabel="Removing…"
      danger
      onConfirm={() => sendJson(`${base(schoolCode)}/people/staff/${staff.id}/assignments/${assignment.id}/remove`, "POST")}
      onDone={onDone}
    >
      <p>
        {fullName(staff)} no longer teaches {assignment.subjectName} to {assignment.classGroupName} {assignment.armName}. You can add it
        again.
      </p>
    </ConfirmDialog>
  );
}
