import fs from "node:fs/promises";
import path from "node:path";

// Outgoing email (domain-implementation-plan.md §0.5.C): one tiny interface, three implementations
// chosen by EMAIL_TRANSPORT.
//   resend   — production. Uses RESEND_API_KEY and EMAIL_FROM. (Plain fetch: no SDK dependency.)
//   console  — development. Prints the whole message, link included, to the server log.
//   file     — tests. Appends one JSON line per message to EMAIL_FILE; the tests read it as the inbox.
// Unset: `resend` when RESEND_API_KEY is present, otherwise `console` — with a loud warning in
// production, because a reset link printed to a log is not delivered to anyone.
//
// A send failure is logged and swallowed by the caller: showing it to the requester would be an oracle
// for "this address has an account".

export type EmailMessage = { to: string; subject: string; text: string };

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

const resend: EmailTransport = {
  async send(message) {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!key || !from) throw new Error("EMAIL_TRANSPORT=resend needs RESEND_API_KEY and EMAIL_FROM");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}`);
  },
};

const consoleTransport: EmailTransport = {
  async send(message) {
    console.log(`[EMAIL → ${message.to}] ${message.subject}\n${message.text}\n`);
  },
};

const fileTransport: EmailTransport = {
  async send(message) {
    const file = process.env.EMAIL_FILE;
    if (!file) throw new Error("EMAIL_TRANSPORT=file needs EMAIL_FILE");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify({ ...message, at: new Date().toISOString() }) + "\n");
  },
};

let warned = false;

export function getEmailTransport(): EmailTransport {
  const chosen = process.env.EMAIL_TRANSPORT || (process.env.RESEND_API_KEY ? "resend" : "console");
  if (chosen === "console" && process.env.NODE_ENV === "production" && !warned) {
    warned = true;
    console.warn(
      "[email] EMAIL_TRANSPORT=console in production: reset links are printed to this log and delivered to no one. " +
        "Set RESEND_API_KEY and EMAIL_FROM.",
    );
  }
  if (chosen === "resend") return resend;
  if (chosen === "file") return fileTransport;
  if (chosen === "console") return consoleTransport;
  throw new Error(`Unknown EMAIL_TRANSPORT "${chosen}" (resend | console | file)`);
}

/// Sends, and never throws: callers run this where a failure must not change the response.
export async function sendEmailQuietly(message: EmailMessage): Promise<boolean> {
  try {
    await getEmailTransport().send(message);
    return true;
  } catch (error) {
    console.error("[email] send failed:", error instanceof Error ? error.message : error);
    return false;
  }
}
