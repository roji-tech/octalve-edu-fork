import "../support/env";
import { test, expect } from "@playwright/test";
import { Permission, Role } from "@prisma/client";
import { isAuthorized } from "@/lib/auth/authorize";

// The whole truth table of "may this member use this route?" (domain-implementation-plan.md, "Build design — Phase 1.0", decision 5).
const ROLES = Object.values(Role);
const PERMISSIONS = Object.values(Permission);
const STAFF: Role[] = ["TEACHING_STAFF", "NON_TEACHING_STAFF"];

test.describe("isAuthorized", () => {
  test("no requirement: any member passes, whatever the role or permissions", () => {
    for (const role of ROLES) expect(isAuthorized({ role, permissions: [] }, {}), role).toBe(true);
  });

  test("`roles` only: exactly the listed roles — and an ADMIN is NOT implied (a teachers-only route stays teachers-only)", () => {
    for (const role of ROLES) {
      expect(isAuthorized({ role, permissions: [] }, { roles: ["TEACHING_STAFF"] }), role).toBe(role === "TEACHING_STAFF");
      expect(isAuthorized({ role, permissions: [] }, { roles: ["ADMIN", "PARENT"] }), role).toBe(role === "ADMIN" || role === "PARENT");
    }
  });

  test("`roles` only: permissions held do NOT widen a roles-only route", () => {
    for (const permission of PERMISSIONS)
      expect(isAuthorized({ role: "NON_TEACHING_STAFF", permissions: [permission] }, { roles: ["TEACHING_STAFF"] })).toBe(false);
  });

  test("`roles: []` lets nobody in (it fails closed)", () => {
    for (const role of ROLES) expect(isAuthorized({ role, permissions: [] }, { roles: [] }), role).toBe(false);
  });

  test("`permissions` only: an ADMIN implies every permission; everyone else needs one that is listed", () => {
    for (const wanted of PERMISSIONS) {
      expect(isAuthorized({ role: "ADMIN", permissions: [] }, { permissions: [wanted] }), `ADMIN ${wanted}`).toBe(true);
      for (const role of STAFF) {
        for (const held of PERMISSIONS) {
          expect(
            isAuthorized({ role, permissions: [held] }, { permissions: [wanted] }),
            `${role} holds ${held}, route wants ${wanted}`,
          ).toBe(held === wanted);
        }
        expect(isAuthorized({ role, permissions: [] }, { permissions: [wanted] }), `${role} holds nothing`).toBe(false);
      }
      for (const role of ["STUDENT", "PARENT"] as const)
        expect(isAuthorized({ role, permissions: [] }, { permissions: [wanted] }), role).toBe(false);
    }
  });

  test("`permissions` listing several: holding ANY one is enough, holding an unlisted one is not", () => {
    const wants = { permissions: ["CAN_APPROVE_RESULTS", "CAN_PUBLISH_CONTENT"] as Permission[] };
    expect(isAuthorized({ role: "TEACHING_STAFF", permissions: ["CAN_PUBLISH_CONTENT"] }, wants)).toBe(true);
    expect(isAuthorized({ role: "TEACHING_STAFF", permissions: ["CAN_MANAGE_FINANCE", "CAN_APPROVE_RESULTS"] }, wants)).toBe(true);
    expect(isAuthorized({ role: "TEACHING_STAFF", permissions: ["CAN_MANAGE_FINANCE", "CAN_MANAGE_USERS"] }, wants)).toBe(false);
  });

  test("both given: role OR permission — a role in the list passes without any permission, and the reverse", () => {
    const wants = { roles: ["TEACHING_STAFF"] as Role[], permissions: ["CAN_MANAGE_FINANCE"] as Permission[] };
    expect(isAuthorized({ role: "TEACHING_STAFF", permissions: [] }, wants)).toBe(true); // the role
    expect(isAuthorized({ role: "NON_TEACHING_STAFF", permissions: ["CAN_MANAGE_FINANCE"] }, wants)).toBe(true); // the permission
    expect(isAuthorized({ role: "NON_TEACHING_STAFF", permissions: [] }, wants)).toBe(false);
    expect(isAuthorized({ role: "ADMIN", permissions: [] }, wants)).toBe(true); // implied, because `permissions` is given
    expect(isAuthorized({ role: "PARENT", permissions: [] }, wants)).toBe(false);
  });
});
