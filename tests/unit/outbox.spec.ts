import fs from "node:fs/promises";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { EMAIL_FILE } from "../support/env";
import { readOutbox, resetOutbox, waitForMail } from "../support/outbox";

// The test inbox is a file the servers append to. This pins how the READER treats it, because a reader that turns any problem
// into "no mail" once made every mail test in a run fail with "found 0" after a single torn line (a crash mid-append).
// Serial by configuration (one worker), so touching the shared file here is safe as long as it is put back.

async function withOutbox(contents: string | null, run: () => Promise<void>) {
  const before = await fs.readFile(EMAIL_FILE, "utf8").catch(() => null);
  try {
    if (contents === null) await resetOutbox();
    else {
      await fs.mkdir(path.dirname(EMAIL_FILE), { recursive: true });
      await fs.writeFile(EMAIL_FILE, contents);
    }
    await run();
  } finally {
    if (before === null) await resetOutbox();
    else await fs.writeFile(EMAIL_FILE, before);
  }
}

const line = (to: string) => JSON.stringify({ to, subject: "s", text: "t", at: "2026-01-01T00:00:00.000Z" }) + "\n";

test("a missing outbox is an empty inbox", async () => {
  await withOutbox(null, async () => {
    expect(await readOutbox()).toEqual([]);
  });
});

test("messages are read in order, and blank lines are ignored", async () => {
  await withOutbox(line("a@x.test") + "\n" + line("b@x.test"), async () => {
    expect((await readOutbox()).map((m) => m.to)).toEqual(["a@x.test", "b@x.test"]);
  });
});

test("a corrupt line is an ERROR naming the file — not an empty inbox", async () => {
  // NUL bytes glued onto a real message: exactly what a crash mid-append left behind.
  await withOutbox(line("a@x.test") + "\u0000\u0000\u0000" + line("b@x.test"), async () => {
    await expect(readOutbox()).rejects.toThrow(/outbox\.jsonl is corrupt \(entry 2 is not JSON/);
    await expect(waitForMail("b@x.test", 1, 300)).rejects.toThrow(/corrupt/); // and waiting for mail surfaces it, not "found 0"
  });
});

test("resetOutbox empties the inbox and is harmless when there is no file", async () => {
  await withOutbox(line("a@x.test"), async () => {
    await resetOutbox();
    await resetOutbox();
    expect(await readOutbox()).toEqual([]);
  });
});
