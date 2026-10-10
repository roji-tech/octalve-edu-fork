import "../support/env";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { Role, AnnouncementStatus } from "@prisma/client";
import { addMembership, createTenant, createUser, removeCreatedTenants, seedInstance, type TestTenant, type TestUser } from "../support/db";
import { api, cookieHeader, loginAs } from "../support/http";

let a: TestTenant;
let b: TestTenant;
let adminA: TestUser;
let teacherA: TestUser;
let studentA: TestUser;
let adminB: TestUser;

const cookie: Record<string, string> = {};

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, { baseUrl: SAAS_URL });
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha Broadcast Academy", campuses: ["North Campus", "South Campus"] });
  b = await createTenant({ name: "Beta Broadcast School" });

  adminA = await createUser();
  teacherA = await createUser();
  studentA = await createUser();
  adminB = await createUser();

  await addMembership(adminA.id, a.id, Role.ADMIN);
  await addMembership(teacherA.id, a.id, Role.TEACHING_STAFF);
  await addMembership(studentA.id, a.id, Role.STUDENT);
  await addMembership(adminB.id, b.id, Role.ADMIN);

  cookie.adminA = await cookieFor(adminA);
  cookie.teacherA = await cookieFor(teacherA);
  cookie.studentA = await cookieFor(studentA);
  cookie.adminB = await cookieFor(adminB);
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe("Announcements API & Audience Isolation", () => {
  let broadcastNoticeId: string;
  let staffOnlyNoticeId: string;

  test("admin can create a school-wide broadcast notice", async () => {
    const res = await api(`/api/v1/schools/${a.code}/announcements`, {
      method: "POST",
      body: {
        title: "End of Term Assembly",
        body: "All students and staff are invited to the main auditorium on Friday.",
        targetRoles: [], // School-wide
        status: AnnouncementStatus.PUBLISHED,
        isPinned: true,
      },
      cookie: cookie.adminA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({
      title: "End of Term Assembly",
      isPinned: true,
      status: "PUBLISHED",
      targetRoles: [],
    });
    broadcastNoticeId = res.json.data.id;
  });

  test("teacher can create a targeted announcement for staff", async () => {
    const res = await api(`/api/v1/schools/${a.code}/announcements`, {
      method: "POST",
      body: {
        title: "Staff Meeting 3PM",
        body: "Mandatory curriculum sync in the staff common room.",
        targetRoles: [Role.TEACHING_STAFF, Role.NON_TEACHING_STAFF],
        status: AnnouncementStatus.PUBLISHED,
        isPinned: false,
      },
      cookie: cookie.teacherA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(201);
    staffOnlyNoticeId = res.json.data.id;
  });

  test("student cannot create announcements (403)", async () => {
    const res = await api(`/api/v1/schools/${a.code}/announcements`, {
      method: "POST",
      body: {
        title: "Student Notice",
        body: "Unauthorized announcement attempt.",
      },
      cookie: cookie.studentA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(403);
  });

  test("audience filtering: student sees school-wide notice but NOT staff-only notice", async () => {
    const res = await api(`/api/v1/schools/${a.code}/announcements`, {
      method: "GET",
      cookie: cookie.studentA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(200);
    const ids = res.json.data.items.map((item: { id: string }) => item.id);

    expect(ids).toContain(broadcastNoticeId);
    expect(ids).not.toContain(staffOnlyNoticeId); // Filtered out by role
  });

  test("audience filtering: teacher sees both school-wide and staff-only notices", async () => {
    const res = await api(`/api/v1/schools/${a.code}/announcements`, {
      method: "GET",
      cookie: cookie.teacherA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(200);
    const ids = res.json.data.items.map((item: { id: string }) => item.id);

    expect(ids).toContain(broadcastNoticeId);
    expect(ids).toContain(staffOnlyNoticeId);
  });

  test("author can update own announcement", async () => {
    const res = await api(`/api/v1/schools/${a.code}/announcements/${staffOnlyNoticeId}`, {
      method: "PATCH",
      body: {
        title: "Staff Meeting Rescheduled to 3:30PM",
      },
      cookie: cookie.teacherA,
      baseUrl: SAAS_URL,
    });

    expect(res.status).toBe(200);
    expect(res.json.data.title).toBe("Staff Meeting Rescheduled to 3:30PM");
  });

  test("cross-tenant isolation: Tenant B admin cannot read, edit or delete Tenant A notice", async () => {
    const getRes = await api(`/api/v1/schools/${b.code}/announcements/${broadcastNoticeId}`, {
      method: "GET",
      cookie: cookie.adminB,
      baseUrl: SAAS_URL,
    });
    expect(getRes.status).toBe(404);

    const patchRes = await api(`/api/v1/schools/${b.code}/announcements/${broadcastNoticeId}`, {
      method: "PATCH",
      body: { title: "Hostile rename" },
      cookie: cookie.adminB,
      baseUrl: SAAS_URL,
    });
    expect(patchRes.status).toBe(404);

    const delRes = await api(`/api/v1/schools/${b.code}/announcements/${broadcastNoticeId}`, {
      method: "DELETE",
      cookie: cookie.adminB,
      baseUrl: SAAS_URL,
    });
    expect(delRes.status).toBe(404);
  });

  test("admin can delete notice in their school", async () => {
    const delRes = await api(`/api/v1/schools/${a.code}/announcements/${broadcastNoticeId}`, {
      method: "DELETE",
      cookie: cookie.adminA,
      baseUrl: SAAS_URL,
    });
    expect(delRes.status).toBe(200);
  });
});
