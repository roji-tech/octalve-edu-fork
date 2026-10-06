import type { Permission, Role } from "@prisma/client";

// The one decision "may this member use this route?" (domain-implementation-plan.md, "Build design — Phase 1.0", decision 5), as a
// pure function so its whole truth table is unit-tested. `withAuth` calls it with the role and permissions of the membership IN THE
// VERIFIED SCHOOL — read from the database on every request, never from the client, a cookie or the shell.
//
//   neither `roles` nor `permissions`  → any active member
//   `roles` only                       → the member's role is listed (an ADMIN is NOT implied: a teachers-only route stays teachers-only)
//   `permissions` given                → the role is in `roles` (if given) OR the member is an ADMIN (ADMIN implies every permission)
//                                        OR holds at least one listed permission
//
// "ADMIN implies every permission" applies to the `permissions` option only, never to `roles`: implying roles would silently open every
// role-restricted route to administrators and change behaviour that is tested today.

export type RouteRequirement = { roles?: readonly Role[]; permissions?: readonly Permission[] };
export type Holder = { role: Role; permissions: readonly Permission[] };

export function isAuthorized(holder: Holder, required: RouteRequirement): boolean {
  const { roles, permissions } = required;
  if (roles === undefined && permissions === undefined) return true;
  if (roles?.includes(holder.role)) return true;
  if (permissions === undefined) return false;
  return holder.role === "ADMIN" || permissions.some((wanted) => holder.permissions.includes(wanted));
}
