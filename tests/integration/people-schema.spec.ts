import "../support/env";
import { test, expect } from "@playwright/test";
import { createTenant, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";

// The rules the database itself states for people records (migration 20261015090000_phase_1_2_people; plan "Build design — Phase 1.2"): CHECK constraints
// and partial unique indexes. The services check the same things first and say why; these tests prove the database would refuse even if one did not.

let school: TestTenant;
let other: TestTenant;

test.beforeAll(async () => {
  await seedInstance();
  school = await createTenant({ name: "People schema school" });
  other = await createTenant({ name: "People schema other" });
});
test.afterAll(async () => {
  await removeCreatedTenants();
});

const student = (tenantId: string, over: Record<string, unknown> = {}) =>
  db.studentRecord.create({
    data: {
      tenantId,
      firstName: "Sade",
      lastName: "Okoro",
      dateOfBirth: new Date("2012-05-01"),
      admissionNo: `ADM/${Math.random().toString(36).slice(2, 9)}`,
      ...over,
    },
  });
const constraint = /check constraint|violates/i;
const unique = /unique/i;

test.describe("student records", () => {
  test("names are 1–80 characters once trimmed (middle name too)", async () => {
    await expect(student(school.id, { firstName: "   " })).rejects.toThrow(constraint);
    await expect(student(school.id, { lastName: "" })).rejects.toThrow(constraint);
    await expect(student(school.id, { middleName: "  " })).rejects.toThrow(constraint);
    await expect(student(school.id, { firstName: "a".repeat(81) })).rejects.toThrow(constraint);
    await expect(student(school.id, { firstName: "a".repeat(80), middleName: "b".repeat(80) })).resolves.toBeTruthy();
  });

  test("a date of birth before 1900-01-01 is refused, 1900-01-01 is not", async () => {
    await expect(student(school.id, { dateOfBirth: new Date("1899-12-31") })).rejects.toThrow(constraint);
    await expect(student(school.id, { dateOfBirth: new Date("1900-01-01") })).resolves.toBeTruthy();
  });

  test("an admission number has the shape the service enforces: 1–30 of letters, digits and / - . starting with a letter or digit", async () => {
    for (const bad of ["", " 1", "/1", "-1", "a b", "a_b", "A".repeat(31)]) {
      await expect(student(school.id, { admissionNo: bad }), JSON.stringify(bad)).rejects.toThrow(constraint);
    }
    for (const good of ["1", "2026/0001", "A.b-c/9", "A".repeat(30)]) {
      await expect(student(school.id, { admissionNo: good }), good).resolves.toBeTruthy();
    }
  });

  test("an admission number is unique per school ignoring case — archived records still hold theirs — and free in another school", async () => {
    await student(school.id, { admissionNo: "UNQ/1" });
    await expect(student(school.id, { admissionNo: "unq/1" })).rejects.toThrow(unique);
    const archived = await student(school.id, { admissionNo: "UNQ/2", archivedAt: new Date() });
    await expect(student(school.id, { admissionNo: "UNQ/2" })).rejects.toThrow(unique);
    expect(archived.archivedAt).not.toBeNull();
    await expect(student(other.id, { admissionNo: "UNQ/1" })).resolves.toBeTruthy();
  });
});

test.describe("staff and guardian records", () => {
  const staff = (over: Record<string, unknown> = {}) =>
    db.staffRecord.create({ data: { tenantId: school.id, category: "TEACHING", firstName: "Tola", lastName: "Bello", ...over } });
  const guardian = (over: Record<string, unknown> = {}) =>
    db.guardianRecord.create({ data: { tenantId: school.id, firstName: "Gbenga", lastName: "Okoro", ...over } });

  test("phone and email shapes are enforced; a blank phone or email is NULL, not an empty string", async () => {
    for (const make of [staff, guardian]) {
      await expect(make({ phone: "123" })).rejects.toThrow(constraint);
      await expect(make({ phone: "080-abc-1234" })).rejects.toThrow(constraint);
      await expect(make({ phone: "1".repeat(21) })).rejects.toThrow(constraint);
      await expect(make({ phone: "+234 803 123 4567" })).resolves.toBeTruthy();
      await expect(make({ email: "Upper@Example.com" })).rejects.toThrow(constraint);
      await expect(make({ email: "no-at-sign" })).rejects.toThrow(constraint);
      await expect(make({ email: "a b@example.com" })).rejects.toThrow(constraint);
      await expect(make({ email: "" })).rejects.toThrow(constraint);
    }
  });

  test("a staff email is unique per school among LIVE records, ignoring case, and free once archived or in another school", async () => {
    const first = await staff({ email: "tola@example.com" });
    await expect(staff({ email: "tola@example.com" })).rejects.toThrow(unique);
    await db.staffRecord.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
    await expect(staff({ email: "tola@example.com" })).resolves.toBeTruthy();
    await expect(
      db.staffRecord.create({
        data: { tenantId: other.id, category: "TEACHING", firstName: "T", lastName: "B", email: "tola@example.com" },
      }),
    ).resolves.toBeTruthy();
  });

  test("the admission counter cannot go below 1 or hold a year outside 1900–9999", async () => {
    await expect(db.admissionCounter.create({ data: { tenantId: school.id, year: 2026, next: 0 } })).rejects.toThrow(constraint);
    await expect(db.admissionCounter.create({ data: { tenantId: school.id, year: 1899 } })).rejects.toThrow(constraint);
    await expect(db.admissionCounter.create({ data: { tenantId: school.id, year: 10000 } })).rejects.toThrow(constraint);
    await expect(db.admissionCounter.create({ data: { tenantId: school.id, year: 2026 } })).resolves.toMatchObject({ next: 1 });
    await expect(db.admissionCounter.create({ data: { tenantId: school.id, year: 2026 } })).rejects.toThrow(unique);
  });
});

test.describe("guardian links", () => {
  test("one live primary contact per student; a revoked link is never primary and says when it was revoked", async () => {
    const pupil = await student(school.id);
    const [g1, g2, g3] = await Promise.all(
      ["One", "Two", "Three"].map((lastName) => db.guardianRecord.create({ data: { tenantId: school.id, firstName: "G", lastName } })),
    );
    const link = (guardianId: string, over: Record<string, unknown> = {}) =>
      db.guardianLink.create({ data: { tenantId: school.id, studentId: pupil.id, guardianId, relationship: "GUARDIAN", ...over } });

    const first = await link(g1.id, { isPrimary: true });
    expect(first.status).toBe("APPROVED"); // the default in 1.2: only an administrator creates links
    await expect(link(g2.id, { isPrimary: true })).rejects.toThrow(unique);
    const second = await link(g2.id);
    await expect(db.guardianLink.update({ where: { id: second.id }, data: { isPrimary: true } })).rejects.toThrow(unique);
    await expect(link(g1.id)).rejects.toThrow(unique); // the same guardian twice

    // revoked ⇔ revokedAt set; a revoked link cannot stay primary
    await expect(db.guardianLink.update({ where: { id: first.id }, data: { status: "REVOKED" } })).rejects.toThrow(constraint);
    await expect(db.guardianLink.update({ where: { id: first.id }, data: { revokedAt: new Date() } })).rejects.toThrow(constraint);
    await expect(db.guardianLink.update({ where: { id: first.id }, data: { status: "REVOKED", revokedAt: new Date() } })).rejects.toThrow(
      constraint,
    ); // still primary
    await db.guardianLink.update({ where: { id: first.id }, data: { status: "REVOKED", revokedAt: new Date(), isPrimary: false } });
    // the revoked one no longer holds the primary slot
    await expect(db.guardianLink.update({ where: { id: second.id }, data: { isPrimary: true } })).resolves.toBeTruthy();
    await expect(link(g3.id, { isPrimary: true })).rejects.toThrow(unique);
  });
});

test.describe("enrolment", () => {
  test("a student is enrolled at most once per session (any arm) — and again in a later one", async () => {
    const group = await db.classGroup.create({ data: { tenantId: school.id, name: "Enrol group" } });
    const armA = await db.classArm.create({ data: { tenantId: school.id, classGroupId: group.id, name: "A" } });
    const armB = await db.classArm.create({ data: { tenantId: school.id, classGroupId: group.id, name: "B" } });
    const s1 = await db.academicSession.create({
      data: { tenantId: school.id, label: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });
    const s2 = await db.academicSession.create({
      data: { tenantId: school.id, label: "2027/2028", startDate: new Date("2027-09-01"), endDate: new Date("2028-07-31") },
    });
    const pupil = await student(school.id);
    const enrol = (sessionId: string, classArmId: string) =>
      db.studentEnrollment.create({ data: { tenantId: school.id, studentId: pupil.id, sessionId, classArmId } });

    const first = await enrol(s1.id, armA.id);
    expect(first.status).toBe("ACTIVE");
    await expect(enrol(s1.id, armB.id)).rejects.toThrow(unique);
    await expect(enrol(s1.id, armA.id)).rejects.toThrow(unique);
    await expect(enrol(s2.id, armB.id)).resolves.toBeTruthy();
  });
});
