import { z } from "zod";
import { Permission, Role } from "@prisma/client";
import { fail } from "@/lib/api/envelope";
import type { MemberFailure } from "./service";

// The HTTP face of the members/invitations rules: one place that turns a refusal into a status, a stable `code` and words a
// person can act on. The unknown-person and wrong-school cases share ONE answer (NOT_FOUND) — see service.ts.

export const ROLES = Object.values(Role) as [Role, ...Role[]];

/// A path parameter that cannot be an id of ours is the same "no such thing" as one that merely does not exist.
export const isPlausibleId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

export const emailField = z
  .string({ error: "Enter an email address." })
  .trim()
  .max(254, "That email address is too long.")
  .email("Enter a valid email address.")
  .toLowerCase();

export const roleField = z.enum(ROLES, { error: "Choose a role." });
export const PERMISSIONS = Object.values(Permission) as [Permission, ...Permission[]];
/// The full desired set of permissions: real values only, at most one of each (a duplicate is a client bug, refused rather than merged).
export const permissionsField = z
  .array(z.enum(PERMISSIONS, { error: "Choose from the listed permissions." }), { error: "Give a list of permissions." })
  .max(PERMISSIONS.length)
  .refine((list) => new Set(list).size === list.length, "Give each permission once.");
export const campusIdField = z.string().min(1).max(64);

export const notFound = (what: string) => fail(`No such ${what}.`, 404, "NOT_FOUND");

export function memberFailure(reason: MemberFailure): Response {
  switch (reason) {
    case "NOT_FOUND":
      return notFound("member");
    case "SELF":
      return fail("You can't change your own access here. Ask another administrator.", 409, "SELF");
    case "LAST_ADMIN":
      return fail("This is the school's last administrator. Make someone else an administrator first.", 409, "LAST_ADMIN");
    case "INVALID_CAMPUS":
      return fail("Choose one of this school's campuses.", 400, "VALIDATION", [
        { path: "body.campusId", message: "Choose one of this school's campuses." },
      ]);
    case "PERMISSIONS_NOT_APPLICABLE":
      return fail("Extra permissions can only be given to teaching and non-teaching staff.", 400, "VALIDATION", [
        { path: "body.permissions", message: "Extra permissions can only be given to teaching and non-teaching staff." },
      ]);
    case "DEACTIVATED":
      return fail("This person is deactivated. Reactivate them first.", 409, "DEACTIVATED");
  }
}
