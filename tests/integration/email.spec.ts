import "../support/env";
import { test, expect } from "@playwright/test";
import { getEmailTransport, sendEmailQuietly } from "@/lib/email/transport";
import { passwordChangedEmail, resetEmail, resetLink } from "@/lib/email/messages";
import { HTTP_URL } from "../support/env";
import { mailTo } from "../support/outbox";
import { uniqueEmail } from "../support/db";

test.describe("the file transport (what the tests read as the inbox)", () => {
  test("appends one JSON line per message", async () => {
    const to = uniqueEmail("inbox");
    await getEmailTransport().send({ to, subject: "Hello", text: "Body" });
    await getEmailTransport().send({ to, subject: "Again", text: "Body 2" });
    const mail = await mailTo(to);
    expect(mail.map((m) => m.subject)).toEqual(["Hello", "Again"]);
  });
});

test.describe("transport selection and failure handling", () => {
  test("an unknown EMAIL_TRANSPORT is a loud error, not a silent default", () => {
    const before = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = "carrier-pigeon";
    try {
      expect(() => getEmailTransport()).toThrow(/Unknown EMAIL_TRANSPORT/);
    } finally {
      process.env.EMAIL_TRANSPORT = before;
    }
  });

  test("sendEmailQuietly never throws (a failure must not change an API response) and reports it", async () => {
    const before = process.env.EMAIL_FILE;
    delete process.env.EMAIL_FILE; // the file transport now fails
    const originalError = console.error;
    console.error = () => undefined;
    try {
      expect(await sendEmailQuietly({ to: "a@b.test", subject: "s", text: "t" })).toBe(false);
    } finally {
      console.error = originalError;
      process.env.EMAIL_FILE = before;
    }
  });
});

test.describe("the messages", () => {
  test("the reset link carries the token in the URL FRAGMENT, never the query string", () => {
    const link = resetLink("TOKEN123");
    expect(link).toBe(`${HTTP_URL}/reset-password#token=TOKEN123`);
    expect(link).not.toContain("?");
    const mail = resetEmail("x@y.test", "TOKEN123");
    expect(mail.text).toContain(link);
    expect(mail.text).toMatch(/30 minutes/);
    expect(mail.text).toMatch(/ignore this message/i);
  });

  test("the changed-password notice tells them what to do if it wasn't them", () => {
    const mail = passwordChangedEmail("x@y.test");
    expect(mail.text).toContain("/forgot-password");
    expect(mail.text).not.toMatch(/#token=/);
  });
});
