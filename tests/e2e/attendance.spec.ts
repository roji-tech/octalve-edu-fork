import { test, expect } from "../support/fixtures";
import { Role, addMembership, createTenant, createUser, db, removeCreatedTenants, seedInstance, type TestTenant } from "../support/db";
import { SAAS_URL } from "../support/env";
import { signInThroughUi } from "./helpers";

test.use({ baseURL: SAAS_URL });

let school: TestTenant;

test.beforeAll(async () => {
  await seedInstance();
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

test.beforeEach(async () => {
  school = await createTenant({ name: "Bright Stars Academy" });
});

test.afterEach(async () => {
  await removeCreatedTenants();
});

test.describe("Attendance Screen", () => {
  test("renders attendance panel, switches status, and saves roll call", async ({ page }) => {
    // 1. Setup session, class group, arm, and enrolled student in DB
    const admin = await createUser({ name: "Amina Yusuf" });
    await addMembership(admin.id, school.id, Role.ADMIN);

    const session = await db.academicSession.create({
      data: {
        tenantId: school.id,
        label: "2026/2027",
        startDate: new Date("2026-09-01T00:00:00Z"),
        endDate: new Date("2027-07-20T00:00:00Z"),
        status: "ACTIVE",
      },
    });

    const classGroup = await db.classGroup.create({
      data: {
        tenantId: school.id,
        name: "Primary 1",
        sortOrder: 1,
      },
    });

    const arm = await db.classArm.create({
      data: {
        tenantId: school.id,
        classGroupId: classGroup.id,
        name: "Diamond",
      },
    });

    const student = await db.studentRecord.create({
      data: {
        tenantId: school.id,
        admissionNo: "BSA-2026-001",
        firstName: "Fatima",
        lastName: "Aliyu",
        dateOfBirth: new Date("2019-03-15T00:00:00Z"),
      },
    });

    await db.studentEnrollment.create({
      data: {
        tenantId: school.id,
        studentId: student.id,
        sessionId: session.id,
        classArmId: arm.id,
        status: "ACTIVE",
      },
    });

    // 2. Sign in and navigate to attendance section
    await signInThroughUi(page, admin);
    await page.goto(`/schools/${school.code}/academics?section=attendance`);

    await expect(page.getByRole("heading", { level: 2, name: "Daily Attendance" })).toBeVisible();
    await expect(page.getByText("Aliyu, Fatima")).toBeVisible();
    await expect(page.getByText("Admission: BSA-2026-001")).toBeVisible();

    // 3. Mark All Present action
    const markAllBtn = page.getByRole("button", { name: "Mark All Present" });
    await expect(markAllBtn).toBeVisible();
    await markAllBtn.click();

    // 4. Toggle specific status (e.g. LATE)
    const lateBtn = page.getByRole("button", { name: "LATE" });
    await expect(lateBtn).toBeVisible();
    await lateBtn.click();

    // 5. Save attendance
    const saveBtn = page.getByRole("button", { name: "Save Roll Call" }).first();
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // 6. Expect success notification
    await expect(page.getByText(/Attendance saved for/)).toBeVisible();
  });
});
