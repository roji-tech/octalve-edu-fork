import { test, expect } from "@playwright/test";
import { initialsOf, isActive, navFor, pageLabel, schoolFromPath, type ShellSchool } from "@/components/shell/nav";

// The shell's navigation is DATA and display-only (domain-implementation-plan.md §0.5.2-H): which links to draw for the
// school a path is in. These tests pin that model — in particular that a path naming a school the person is not in matches
// nothing, and that role-hiding follows the role in THAT school (the page and API still decide access).

const admin: ShellSchool = { code: "riverside", name: "Riverside Academy", role: "ADMIN" };
const teacher: ShellSchool = { code: "hillcrest", name: "Hillcrest School", role: "TEACHING_STAFF" };
const schools = [admin, teacher];

test.describe("navFor", () => {
  test("outside any school: one entry, the school chooser", () => {
    expect(navFor(null)).toMatchObject([{ label: "Your schools", href: "/dashboard" }]);
  });

  test("an ADMIN of a school: Overview, Users (a page) and Settings (not built yet → no link)", () => {
    const items = navFor(admin);
    expect(items.map((i) => i.label)).toEqual(["Overview", "Users", "Settings"]);
    expect(items[0].href).toBe("/schools/riverside");
    expect(items[1].href).toBe("/schools/riverside/users");
    expect(items.filter((i) => i.href === null).map((i) => i.label)).toEqual(["Settings"]); // "Soon", never a dead link
  });

  test("everyone else sees Overview only — decided by the role IN THAT SCHOOL", () => {
    for (const role of ["TEACHING_STAFF", "NON_TEACHING_STAFF", "STUDENT", "PARENT"] as const) {
      expect(navFor({ ...admin, role }).map((i) => i.label), role).toEqual(["Overview"]);
    }
    // The same person is an admin in one school and a teacher in another: each school's nav follows its own role.
    expect(navFor(teacher).map((i) => i.label)).toEqual(["Overview"]);
    expect(navFor(admin).map((i) => i.label)).toContain("Users");
  });

  test("the links carry the school's code", () => {
    expect(navFor(teacher)[0].href).toBe("/schools/hillcrest");
  });
});

test.describe("schoolFromPath", () => {
  test("a path inside a school the person belongs to names that school", () => {
    expect(schoolFromPath("/schools/riverside", schools)).toBe(admin);
    expect(schoolFromPath("/schools/riverside/", schools)).toBe(admin);
    expect(schoolFromPath("/schools/hillcrest/users", schools)).toBe(teacher);
    expect(schoolFromPath("/schools/hillcrest/users/abc/edit", schools)).toBe(teacher);
  });

  test("the code is matched the way the resolver matches it: trimmed and lower-cased", () => {
    expect(schoolFromPath("/schools/RIVERSIDE", schools)).toBe(admin);
    expect(schoolFromPath("/schools/Riverside/users", schools)).toBe(admin);
    expect(schoolFromPath("/schools/%20riverside%20", schools)).toBe(admin);
    expect(schoolFromPath("/schools/river%73ide", schools)).toBe(admin); // percent-encoded letters decode first
  });

  test("a school the person is NOT in — real, unknown or malformed — matches nothing", () => {
    expect(schoolFromPath("/schools/someone-elses", schools)).toBeNull();
    expect(schoolFromPath("/schools/riverside-extra", schools)).toBeNull(); // a prefix is not a match
    expect(schoolFromPath("/schools/riversid", schools)).toBeNull();
    expect(schoolFromPath("/schools/", schools)).toBeNull();
    expect(schoolFromPath("/schools", schools)).toBeNull();
    expect(schoolFromPath("/schools/riverside", [])).toBeNull(); // nobody belongs to anything
  });

  test("hostile paths match nothing and never throw", () => {
    for (const path of [
      "/schools/%E0%A4%A", // a malformed escape
      "/schools/..%2Friverside",
      "/schools/riverside%2Fusers%2F..%2F..",
      "/schools//riverside",
      "/schools/%00",
      "/schools/dashboard", // a reserved word can never be a school
      "/schools/" + "a".repeat(200),
      "/x/schools/riverside",
      "/account",
      "/dashboard",
      "",
    ]) {
      expect(() => schoolFromPath(path, schools), path).not.toThrow();
      expect(schoolFromPath(path, schools), path).toBeNull();
    }
  });
});

test.describe("pageLabel and isActive", () => {
  test("the breadcrumb's page name, by path", () => {
    expect(pageLabel("/dashboard")).toBe("Your schools");
    expect(pageLabel("/account")).toBe("Account");
    expect(pageLabel("/account/")).toBe("Account");
    expect(pageLabel("/schools/riverside")).toBe("Overview");
    expect(pageLabel("/schools/riverside/users")).toBe("Users");
    expect(pageLabel("/schools/riverside/users/")).toBe("Users");
    expect(pageLabel("/schools/riverside/unheard-of")).toBeNull(); // no invented names
    expect(pageLabel("/somewhere-else")).toBeNull();
  });

  test("Overview is active only on its own path; other links are active on their sub-paths", () => {
    const overview = { href: "/schools/riverside", exact: true };
    expect(isActive("/schools/riverside", overview)).toBe(true);
    expect(isActive("/schools/riverside/", overview)).toBe(true);
    expect(isActive("/schools/riverside/users", overview)).toBe(false); // a prefix, but not the same page
    const users = { href: "/schools/riverside/users" };
    expect(isActive("/schools/riverside/users", users)).toBe(true);
    expect(isActive("/schools/riverside/users/abc", users)).toBe(true);
    expect(isActive("/schools/riverside/users-other", users)).toBe(false); // a segment boundary, not a string prefix
    expect(isActive("/schools/riverside", users)).toBe(false);
    expect(isActive("/anything", { href: null })).toBe(false); // an unbuilt entry is never "current"
  });
});

test.describe("initialsOf", () => {
  test("first and last word of a name; the email's local part with no name; one letter for one word", () => {
    expect(initialsOf("Amina Yusuf", null)).toBe("AY");
    expect(initialsOf("Amina", null)).toBe("A");
    expect(initialsOf("  amina  bello  yusuf ", null)).toBe("AY");
    expect(initialsOf(null, "ada.obi@school.test")).toBe("AO");
    expect(initialsOf("", "x@y.z")).toBe("X");
    expect(initialsOf(null, null)).toBe("?");
  });

  test("never splits a surrogate pair", () => {
    expect(initialsOf("😀 Smile", null)).toBe("😀S");
  });
});
