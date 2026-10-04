import fs from "node:fs/promises";
import { EMAIL_FILE } from "./env";

// The test "inbox": the app is run with EMAIL_TRANSPORT=file, so every message it sends is a JSON line in
// EMAIL_FILE. Each test uses its own unique addresses, so tests never read each other's mail.

export type SentEmail = { to: string; subject: string; text: string; at: string };

export async function readOutbox(): Promise<SentEmail[]> {
  try {
    const raw = await fs.readFile(EMAIL_FILE, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SentEmail);
  } catch {
    return []; // nothing sent yet
  }
}

export const mailTo = async (to: string) => (await readOutbox()).filter((m) => m.to === to);

/// Waits (polling) for at least `count` messages to `to`. Mail is sent after the HTTP response, so it can
/// arrive a moment later.
export async function waitForMail(to: string, count = 1, timeoutMs = 10_000): Promise<SentEmail[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mail = await mailTo(to);
    if (mail.length >= count) return mail;
    if (Date.now() > deadline) throw new Error(`expected ${count} email(s) to ${to}, found ${mail.length}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/// For "NO email was sent": gives the server time to (wrongly) send one, then reports what arrived.
export async function mailAfterGrace(to: string, graceMs = 1500): Promise<SentEmail[]> {
  await new Promise((r) => setTimeout(r, graceMs));
  return mailTo(to);
}

/// The reset token inside a message's link (it travels in the URL fragment).
export function tokenFrom(mail: SentEmail): string {
  const token = /#token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  if (!token) throw new Error(`no reset link in: ${mail.text}`);
  return token;
}

export const linkFrom = (mail: SentEmail): string => /(https?:\/\/\S+#token=\S+)/.exec(mail.text)![1];
