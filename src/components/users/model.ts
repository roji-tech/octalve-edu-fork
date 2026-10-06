import type { SelectOption } from "@/components/ui/SelectField";
import { ROLE_LABELS } from "@/lib/roles";

// What the Users page gets from the members/invitations API (plan §0.5.4), and the small display rules around it.

export type RoleName = keyof typeof ROLE_LABELS;
export type PermissionName = "CAN_APPROVE_RESULTS" | "CAN_MANAGE_FINANCE" | "CAN_PUBLISH_CONTENT" | "CAN_MANAGE_USERS";

/// The four extra capabilities (plan §1.7), in the order the API returns them, with a plain-language name and what each one lets a person do.
/// Nobody should ever see "CAN_MANAGE_FINANCE".
export const PERMISSION_OPTIONS: { value: PermissionName; label: string; help: string }[] = [
  { value: "CAN_APPROVE_RESULTS", label: "Approve results", help: "Review and approve teachers' submitted results." },
  { value: "CAN_MANAGE_FINANCE", label: "Manage fees and payments", help: "See invoices and record payments." },
  { value: "CAN_PUBLISH_CONTENT", label: "Publish announcements", help: "Publish content to the school." },
  {
    value: "CAN_MANAGE_USERS",
    label: "Manage people",
    help: "Reserved for managing people; it does not let anyone change roles or permissions.",
  },
];
export const permissionLabel = (permission: PermissionName) => PERMISSION_OPTIONS.find((option) => option.value === permission)!.label;

/// Only staff can be given extra permissions: an administrator already has them all, and a student or parent never does (the server and the
/// database both refuse it; the form simply does not offer it).
export const canHoldPermissions = (role: RoleName) => role === "TEACHING_STAFF" || role === "NON_TEACHING_STAFF";
export type CampusOption = { id: string; name: string };

export type Member = {
  userId: string;
  name: string | null;
  email: string | null;
  role: RoleName;
  campusId: string | null;
  campusName: string | null;
  status: "active" | "deactivated";
  joinedAt: string;
  permissions: PermissionName[];
};

export type Invitation = {
  id: string;
  email: string;
  role: RoleName;
  campusId: string | null;
  campusName: string | null;
  invitedByName: string | null;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "expired";
};

export type PageMeta = { page: number; limit: number; total: number; pages: number; hasNext: boolean };

export const ROLE_OPTIONS: SelectOption[] = (Object.keys(ROLE_LABELS) as RoleName[]).map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
}));

export const displayName = (member: Pick<Member, "name" | "email">) => member.name?.trim() || member.email || "Unnamed person";

const UNITS: [string, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/// "Expires in 6 days" · "Expires in 3 hours" · "Expires in 1 minute" · "Expired".
export function expiryText(expiresAt: string, now: number = Date.now()): string {
  const left = new Date(expiresAt).getTime() - now;
  if (left <= 0) return "Expired";
  for (const [unit, size] of UNITS) {
    const count = Math.floor(left / size);
    if (count >= 1) return `Expires in ${count} ${unit}${count === 1 ? "" : "s"}`;
  }
  return "Expires in under a minute";
}
