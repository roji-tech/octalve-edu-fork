import { z } from "zod";
import { Role } from "@prisma/client";
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
      return fail("Choose one of this school's campuses.", 400, "VALIDATION", [{ path: "body.campusId", message: "Choose one of this school's campuses." }]);
    case "DEACTIVATED":
      return fail("This person is deactivated. Reactivate them first.", 409, "DEACTIVATED");
  }
}
