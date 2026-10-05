import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { Role, addMembership, createTenant, createUser, db, deactivateMembership, removeCreatedTenants, seedInstance, uniqueEmail, type TestTenant, type TestUser } from "../support/db";
import { SAAS_URL } from "../support/env";
import { api, cookieHeader, loginAs } from "../support/http";
import { waitForMail, tokenFrom } from "../support/outbox";
import { signInThroughUi } from "./helpers";

// The Users page in a real browser, desktop and phone (domain-implementation-plan.md §0.5.4): the people, their filters and paging,
// inviting, changing role/campus, deactivating and reactivating, and the pending invitations. The SaaS-mode server (several schools).
test.use({ baseURL: SAAS_URL });

let school: TestTenant;
let admin: TestUser;

test.beforeAll(async () => {
  await seedInstance();
});
test.afterAll(async () => {
  await removeCreatedTenants();
});
test.beforeEach(async () => {
  school = await createTenant({ name: "Alpha School", campuses: ["Alpha North", "Alpha South"] });
});
test.afterEach(async () => {
  await removeCreatedTenants();
});

const heading = (page: Page) => page.getByRole("heading", { level: 1, name: "Users" });
const row = (page: Page, text: string | RegExp) => page.getByRole("listitem").filter({ hasText: text });
const dialog = (page: Page) => page.getByRole("dialog");
const notice = (page: Page) => page.getByRole("status").filter({ hasText: /\S/ });

async function signedInAdmin(page: Page, name = "Amina Yusuf") {
  admin = await createUser({ name });
  await addMembership(admin.id, school.id, Role.ADMIN);
  await signInThroughUi(page, admin);
  await page.goto(`/schools/${school.code}/users`);
  await expect(heading(page)).toBeVisible();
  await expect(page.getByText(/^\d+ (person|people)/)).toBeVisible(); // the list has loaded
}
async function member(role: Role, name: string, campus: number | null = 0) {
  const user = await createUser({ name });
  await addMembership(user.id, school.id, role, campus === null ? null : school.campuses[campus].id);
  return user;
}

test.describe("the page", () => {
  test("an administrator sees the school's people — themselves marked 'You' with no actions — and the empty invitations section", async ({ page }) => {
    const tola = await member(Role.TEACHING_STAFF, "Tola Teacher", 0);
    await signedInAdmin(page);
    await expect(page).toHaveTitle(/Users/);
    await expect(page.getByText("2 people")).toBeVisible();
    const mine = row(page, "Amina Yusuf");
    await expect(mine).toContainText("You");
    await expect(mine).toContainText("Administrator");
    await expect(mine).toContainText("All campuses");
    await expect(mine.getByRole("button")).toHaveCount(0); // nobody changes themselves here
    const theirs = row(page, "Tola Teacher");
    await expect(theirs).toContainText("Teaching staff");
    await expect(theirs).toContainText("Alpha North");
    await expect(theirs).toContainText(tola.email);
    await expect(theirs.getByRole("button", { name: "Change role or campus for Tola Teacher" })).toBeVisible();
    await expect(theirs.getByRole("button", { name: "Deactivate Tola Teacher" })).toBeVisible();
    await expect(page.getByText("No invitations are waiting.")).toBeVisible();
  });

  test("anyone who is not an administrator of this school gets the same 403 view as a stranger", async ({ page }) => {
    const teacher = await member(Role.TEACHING_STAFF, "Tola Teacher");
    await signInThroughUi(page, teacher);
    const response = await page.goto(`/schools/${school.code}/users`);
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { level: 1, name: "You don't have access to this school" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible(); // the shell is still around them …
    await expect(page.getByText(school.campuses[0].name)).toHaveCount(0); // … and nothing of the page
  });

  test("search narrows the list as you type (waiting for a pause), filters combine, 'Clear filters' resets, and an empty result says so", async ({ page }) => {
    await member(Role.TEACHING_STAFF, "Tola Teacher", 0);
    await member(Role.PARENT, "Pat Parent", null);
    await signedInAdmin(page);
    await expect(page.getByText("3 people")).toBeVisible();
    await page.getByLabel("Search").fill("tola");
    await expect(page.getByText("1 person match")).toBeVisible();
    await expect(row(page, "Pat Parent")).toHaveCount(0);
    await page.getByLabel("Search").fill("");
    await expect(page.getByText("3 people")).toBeVisible();
    await page.getByLabel("Role", { exact: true }).selectOption("PARENT");
    await expect(page.getByText("1 person match")).toBeVisible();
    await expect(row(page, "Pat Parent")).toBeVisible();
    await page.getByLabel("Search").fill("zzz-no-one");
    await expect(page.getByText("No one matches these filters.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText("3 people")).toBeVisible();
    await expect(page.getByLabel("Role", { exact: true })).toHaveValue("");
  });

  test("a long list is paged: Page 1 of 2, Next and Previous, no one repeated", async ({ page }) => {
    for (let i = 0; i < 22; i++) await member(Role.PARENT, `Parent ${String(i).padStart(2, "0")}`, null);
    await signedInAdmin(page);
    const pages = page.getByRole("navigation", { name: "Pages of people" });
    await expect(pages.getByText("Page 1 of 2")).toBeVisible();
    await expect(pages.getByRole("button", { name: "Previous" })).toBeDisabled();
    await expect(page.getByText("23 people")).toBeVisible();
    const firstPage = await page.getByRole("listitem").filter({ has: page.getByText(/Parent \d\d|Amina/) }).allTextContents();
    await pages.getByRole("button", { name: "Next" }).click();
    await expect(pages.getByText("Page 2 of 2")).toBeVisible();
    await expect(pages.getByRole("button", { name: "Next" })).toBeDisabled();
    const secondPage = await page.getByRole("listitem").filter({ has: page.getByText(/Parent \d\d|Amina/) }).allTextContents();
    expect(secondPage.length).toBeGreaterThan(0);
    expect(secondPage.some((text) => firstPage.includes(text))).toBe(false);
    await pages.getByRole("button", { name: "Previous" }).click();
    await expect(pages.getByText("Page 1 of 2")).toBeVisible();
  });
});

test.describe("inviting", () => {
  test("Invite someone: the dialog opens on the email field; mistakes are explained in place; sending announces it, lists it, and mails a link", async ({ page }) => {
    await signedInAdmin(page);
    const trigger = page.getByRole("button", { name: "Invite someone" });
    await trigger.click();
    const d = dialog(page);
    await expect(d.getByRole("heading", { name: "Invite someone" })).toBeVisible();
    await expect(d.getByLabel("Email address")).toBeFocused();

    await d.getByRole("button", { name: "Send invitation" }).click();
    await expect(d.getByText("Enter an email address.")).toBeVisible();
    await d.getByLabel("Email address").fill("not-an-address");
    await d.getByRole("button", { name: "Send invitation" }).click();
    await expect(d.getByText("Enter a valid email address.")).toBeVisible();

    const to = uniqueEmail("invitee");
    await d.getByLabel("Email address").fill(to);
    await d.getByLabel("Role").selectOption("PARENT");
    await d.getByLabel("Campus").selectOption({ label: "Alpha South" });
    await d.getByRole("button", { name: "Send invitation" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(notice(page)).toContainText(`Invitation sent to ${to}`);

    const pending = row(page, to);
    await expect(pending).toContainText("Parent");
    await expect(pending).toContainText("Alpha South");
    await expect(pending).toContainText("invited by Amina Yusuf");
    await expect(pending).toContainText("Expires in 6 days");
    const [mail] = await waitForMail(to);
    expect(mail.text).toContain("accept-invite#token=");
    expect(tokenFrom(mail)).toHaveLength(43);
  });

  test("an address that is already a member is refused where you are looking, and nothing is sent", async ({ page }) => {
    const tola = await member(Role.TEACHING_STAFF, "Tola Teacher");
    await signedInAdmin(page);
    await page.getByRole("button", { name: "Invite someone" }).click();
    await dialog(page).getByLabel("Email address").fill(tola.email);
    await dialog(page).getByRole("button", { name: "Send invitation" }).click();
    await expect(dialog(page).getByText("That person is already a member of this school.")).toBeVisible();
    await expect(dialog(page)).toBeVisible(); // stays open: fix it and go on
    expect(await db.invitation.count({ where: { tenantId: school.id } })).toBe(0);
  });

  test("Escape and Cancel close the dialog without sending, and a reopened dialog starts clean", async ({ page }) => {
    await signedInAdmin(page);
    const trigger = page.getByRole("button", { name: "Invite someone" });
    await trigger.click();
    await dialog(page).getByLabel("Email address").fill("half.typed@x.test");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog(page).getByLabel("Email address")).toHaveValue("");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toBeHidden();
    expect(await db.invitation.count({ where: { tenantId: school.id } })).toBe(0);
  });

  test("pending invitations: Resend sends a NEW link (the old one dies); Revoke ends it — each announced", async ({ page }) => {
    const to = uniqueEmail("waiting");
    await signedInAdmin(page);
    await page.getByRole("button", { name: "Invite someone" }).click();
    await dialog(page).getByLabel("Email address").fill(to);
    await dialog(page).getByRole("button", { name: "Send invitation" }).click();
    await expect(row(page, to)).toBeVisible();
    const first = tokenFrom((await waitForMail(to))[0]);

    await page.getByRole("button", { name: `Resend the invitation to ${to}` }).click();
    await expect(notice(page)).toContainText(`A new invitation was sent to ${to}`);
    const second = tokenFrom((await waitForMail(to, 2))[1]);
    expect(second).not.toBe(first);
    expect((await api("/api/v1/invitations/preview", { baseUrl: SAAS_URL, body: { token: first } })).status).toBe(400);
    expect((await api("/api/v1/invitations/preview", { baseUrl: SAAS_URL, body: { token: second } })).status).toBe(200);

    await page.getByRole("button", { name: `Revoke the invitation to ${to}` }).click();
    await expect(notice(page)).toContainText(`The invitation to ${to} was revoked`);
    await expect(row(page, to)).toHaveCount(0);
    await expect(page.getByText("No invitations are waiting.")).toBeVisible();
    expect((await api("/api/v1/invitations/preview", { baseUrl: SAAS_URL, body: { token: second } })).status).toBe(400);
  });

  test("an expired invitation says so and offers 'Send again'", async ({ page }) => {
    const to = uniqueEmail("late");
    await db.invitation.create({ data: { tenantId: school.id, email: to, role: Role.PARENT, tokenHash: "f".repeat(64), expiresAt: new Date(Date.now() - 3_600_000) } });
    await signedInAdmin(page);
    const pending = row(page, to);
    await expect(pending).toContainText("Expired");
    await expect(pending.getByRole("button", { name: `Resend the invitation to ${to}` })).toHaveText("Send again");
  });
});

test.describe("changing people", () => {
  test("Edit: change role and campus; the list and the person's NEXT request follow; Escape and Cancel change nothing", async ({ page }) => {
    const tola = await member(Role.TEACHING_STAFF, "Tola Teacher", 0);
    const tolaCookie = cookieHeader((await loginAs(tola, { baseUrl: SAAS_URL })).token!);
    await signedInAdmin(page);
    const edit = row(page, "Tola Teacher").getByRole("button", { name: "Change role or campus for Tola Teacher" });

    await edit.click();
    await expect(dialog(page).getByRole("heading", { name: "Change access for Tola Teacher" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(edit).toBeFocused();
    expect((await db.tenantMembership.findFirstOrThrow({ where: { userId: tola.id } })).role).toBe("TEACHING_STAFF");

    await edit.click();
    await dialog(page).getByRole("button", { name: "Save changes" }).click(); // nothing changed → closes, sends nothing
    await expect(dialog(page)).toBeHidden();
    expect(await db.auditLog.count({ where: { tenantId: school.id, targetId: tola.id, action: { startsWith: "MEMBER_" } } })).toBe(0);

    await edit.click();
    await dialog(page).getByLabel("Role").selectOption("NON_TEACHING_STAFF");
    await dialog(page).getByLabel("Campus").selectOption({ label: "Alpha South" });
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(notice(page)).toContainText("Saved. Tola Teacher is now Non-teaching staff at Alpha South.");
    await expect(row(page, "Tola Teacher")).toContainText("Non-teaching staff");
    await expect(row(page, "Tola Teacher")).toContainText("Alpha South");
    const school_ = await api(`/api/v1/schools/${school.code}`, { baseUrl: SAAS_URL, cookie: tolaCookie });
    expect(school_.json.data).toMatchObject({ role: "NON_TEACHING_STAFF", campuses: [{ name: "Alpha South" }] }); // their next request already sees it
  });

  test("Deactivate asks first and says what it does; confirming ends their access at once; Reactivate brings them back", async ({ page }) => {
    const tola = await member(Role.TEACHING_STAFF, "Tola Teacher", 1);
    const tolaCookie = cookieHeader((await loginAs(tola, { baseUrl: SAAS_URL })).token!);
    await signedInAdmin(page);
    expect((await api(`/api/v1/schools/${school.code}`, { baseUrl: SAAS_URL, cookie: tolaCookie })).status).toBe(200);

    await page.getByRole("button", { name: "Deactivate Tola Teacher" }).click();
    const d = dialog(page);
    await expect(d.getByRole("heading", { name: "Deactivate Tola Teacher?" })).toBeVisible();
    await expect(d).toContainText("They lose access to Alpha School on their next request. Nothing they did is deleted");
    await d.getByRole("button", { name: "Cancel" }).click();
    expect((await api(`/api/v1/schools/${school.code}`, { baseUrl: SAAS_URL, cookie: tolaCookie })).status).toBe(200); // cancelled: nothing happened

    await page.getByRole("button", { name: "Deactivate Tola Teacher" }).click();
    await dialog(page).getByRole("button", { name: "Deactivate", exact: true }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(notice(page)).toContainText("Tola Teacher was deactivated");
    await expect(row(page, "Tola Teacher")).toHaveCount(0); // the default filter shows active people
    expect((await api(`/api/v1/schools/${school.code}`, { baseUrl: SAAS_URL, cookie: tolaCookie })).status).toBe(403); // access ended with their next request

    await page.getByLabel("Status").selectOption("deactivated");
    const gone = row(page, "Tola Teacher");
    await expect(gone).toContainText("Deactivated");
    await gone.getByRole("button", { name: "Reactivate Tola Teacher" }).click();
    await expect(notice(page)).toContainText("Tola Teacher can use Alpha School again.");
    await page.getByLabel("Status").selectOption("active");
    await expect(row(page, "Tola Teacher")).toContainText("Alpha South"); // the same role and campus
    expect((await api(`/api/v1/schools/${school.code}`, { baseUrl: SAAS_URL, cookie: tolaCookie })).status).toBe(200);
  });

  test("focus is never stranded on a control that vanished: after deactivating, it lands on the list summary", async ({ page }) => {
    await member(Role.PARENT, "Pat Parent", null);
    await signedInAdmin(page);
    await page.getByRole("button", { name: "Deactivate Pat Parent" }).click();
    await dialog(page).getByRole("button", { name: "Deactivate", exact: true }).click();
    await expect(row(page, "Pat Parent")).toHaveCount(0);
    await expect(page.getByText(/^1 person/)).toBeFocused();
  });

  test("a person deactivated by someone else in the meantime: the Edit that follows is refused with the server's own words", async ({ page }) => {
    const tola = await member(Role.TEACHING_STAFF, "Tola Teacher", 0);
    await signedInAdmin(page);
    await page.getByRole("button", { name: "Change role or campus for Tola Teacher" }).click();
    await deactivateMembership(tola.id, school.id); // another administrator did it while the dialog was open
    await dialog(page).getByLabel("Role").selectOption("PARENT");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("This person is deactivated. Reactivate them first.");
  });
});
