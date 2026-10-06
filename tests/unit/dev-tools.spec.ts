import "../support/env";
import { test, expect } from "@playwright/test";
import { appEnv, devToolsAccess, devToolsEnabled } from "@/lib/dev-tools";
import { MAX_DEV_EMAILS, MAX_DEV_EMAIL_TEXT, clearDevEmails, getDevEmails, recordDevEmail } from "@/lib/dev/email-inbox";

// The gate for every development affordance. It must FAIL CLOSED: production never gets the tools, and
// "not production" is never inferred from something that is merely unset (VERCEL_ENV is unset on every host that
// isn't Vercel — including a self-hosted production install).

type Env = Record<string, string | undefined>;

test.describe("appEnv", () => {
  const cases: [string, Env, string][] = [
    ["nothing set (a plain `next dev`)", {}, "development"],
    ["NODE_ENV=development", { NODE_ENV: "development" }, "development"],
    ["NODE_ENV=test", { NODE_ENV: "test" }, "development"],
    ["`next start` forces NODE_ENV=production", { NODE_ENV: "production" }, "production"],
    ["APP_ENV=staging", { NODE_ENV: "production", APP_ENV: "staging" }, "staging"],
    ["APP_ENV=development on a production build", { NODE_ENV: "production", APP_ENV: "development" }, "development"],
    ["case and whitespace are forgiven", { APP_ENV: "  STAGING " }, "staging"],
    ["an empty APP_ENV is 'unset'", { NODE_ENV: "production", APP_ENV: "" }, "production"],
    ["an empty APP_ENV on next dev", { APP_ENV: "  " }, "development"],
    ["a typo is production, not development", { APP_ENV: "prod" }, "production"],
    ["…whatever else it looks like", { APP_ENV: "dev" }, "production"],
    ["…even a plausible one", { APP_ENV: "live", NODE_ENV: "development" }, "production"],
    ["VERCEL_ENV=production always wins", { VERCEL_ENV: "production", APP_ENV: "staging", NODE_ENV: "development" }, "production"],
    ["a Vercel preview is not automatically staging", { VERCEL_ENV: "preview", NODE_ENV: "production" }, "production"],
  ];
  for (const [name, env, expected] of cases) {
    test(name, () => expect(appEnv(env)).toBe(expected));
  }
});

test.describe("devToolsAccess / devToolsEnabled", () => {
  test("development: on by default, off only with DEV_TOOLS=false; no token needed", () => {
    expect(devToolsEnabled({})).toBe(true);
    expect(devToolsEnabled({ APP_ENV: "development", NODE_ENV: "production" })).toBe(true);
    expect(devToolsEnabled({ DEV_TOOLS: "false" })).toBe(false);
    expect(devToolsAccess({})).toEqual({ kind: "open" }); // no token needed on your own machine
  });

  test("staging: needs DEV_TOOLS=true AND a token — and says which token", () => {
    const staging = { APP_ENV: "staging", NODE_ENV: "production" };
    expect(devToolsEnabled(staging)).toBe(false);
    expect(devToolsEnabled({ ...staging, DEV_TOOLS: "true" })).toBe(false); // no token: OFF, never "open"
    expect(devToolsEnabled({ ...staging, DEV_TOOLS: "true", DEV_TOOLS_TOKEN: "   " })).toBe(false);
    expect(devToolsEnabled({ ...staging, DEV_TOOLS_TOKEN: "t" })).toBe(false); // token but not switched on
    expect(devToolsEnabled({ ...staging, DEV_TOOLS: "TRUE", DEV_TOOLS_TOKEN: "t" })).toBe(false); // exactly "true"
    expect(devToolsEnabled({ ...staging, DEV_TOOLS: "true", DEV_TOOLS_TOKEN: " t " })).toBe(true);
    expect(devToolsAccess({ ...staging, DEV_TOOLS: "true", DEV_TOOLS_TOKEN: " t " })).toEqual({ kind: "token", token: "t" });
    // "no token configured" is OFF — it is never confused with "no token needed":
    expect(devToolsAccess({ ...staging, DEV_TOOLS: "true" })).toEqual({ kind: "off" });
    expect(devToolsAccess({ ...staging, DEV_TOOLS: "true", DEV_TOOLS_TOKEN: "" })).toEqual({ kind: "off" });
  });

  test("production: never — not with DEV_TOOLS=true, not with a token, not with a Vercel preview's help", () => {
    const loud = { DEV_TOOLS: "true", DEV_TOOLS_TOKEN: "t" };
    expect(devToolsEnabled({ ...loud, NODE_ENV: "production" })).toBe(false);
    expect(devToolsEnabled({ ...loud, APP_ENV: "production" })).toBe(false);
    expect(devToolsEnabled({ ...loud, APP_ENV: "production", NODE_ENV: "development" })).toBe(false);
    expect(devToolsEnabled({ ...loud, VERCEL_ENV: "production", APP_ENV: "staging" })).toBe(false);
    expect(devToolsAccess({ ...loud, APP_ENV: "production" })).toEqual({ kind: "off" });
  });

  test("a mistyped APP_ENV never opens the tools (prod, Prod, live, stage, dev…)", () => {
    for (const APP_ENV of ["prod", "Prod", "live", "stage", "dev", "local", "test", "1", "true"]) {
      expect(devToolsEnabled({ APP_ENV, DEV_TOOLS: "true", DEV_TOOLS_TOKEN: "t" }), APP_ENV).toBe(false);
    }
  });

  test("every combination of the relevant variables obeys the invariants (1,344 of them)", () => {
    const APP_ENVS = [undefined, "", "development", "staging", "production", "prod", "x"];
    const NODE_ENVS = [undefined, "development", "production", "test"];
    const VERCELS = [undefined, "production", "preview", "development"];
    const TOOLS = [undefined, "true", "false", "1"];
    const TOKENS = [undefined, "", "t"];
    let combos = 0;
    for (const APP_ENV of APP_ENVS)
      for (const NODE_ENV of NODE_ENVS)
        for (const VERCEL_ENV of VERCELS)
          for (const DEV_TOOLS of TOOLS)
            for (const DEV_TOOLS_TOKEN of TOKENS) {
              combos++;
              const env = { APP_ENV, NODE_ENV, VERCEL_ENV, DEV_TOOLS, DEV_TOOLS_TOKEN };
              const label = JSON.stringify(env);
              const kind = appEnv(env);
              const enabled = devToolsEnabled(env);
              if (VERCEL_ENV === "production") expect(enabled, label).toBe(false);
              if (kind === "production") expect(enabled, label).toBe(false);
              const access = devToolsAccess(env);
              expect(enabled, label).toBe(access.kind !== "off");
              if (access.kind === "token") {
                expect(kind, label).toBe("staging");
                expect(DEV_TOOLS === "true" && Boolean(DEV_TOOLS_TOKEN), label).toBe(true);
              }
              if (access.kind === "open") expect(kind, label).toBe("development"); // never open anywhere else
            }
    expect(combos).toBe(1344);
  });
});

test.describe("the inbox store", () => {
  test.beforeEach(() => clearDevEmails());

  test("newest first, capped at 50, and a copy is returned", () => {
    for (let i = 1; i <= MAX_DEV_EMAILS + 10; i++) recordDevEmail({ to: "a@b.test", subject: `m${i}`, text: "t" });
    const list = getDevEmails();
    expect(list).toHaveLength(MAX_DEV_EMAILS);
    expect(list[0].subject).toBe(`m${MAX_DEV_EMAILS + 10}`);
    expect(list.at(-1)!.subject).toBe("m11"); // m1–m10 fell off the end
    list.length = 0; // mutating the copy…
    expect(getDevEmails()).toHaveLength(MAX_DEV_EMAILS); // …doesn't touch the store
    expect(MAX_DEV_EMAILS).toBe(50);
  });

  test("every message has a unique id and an ISO timestamp", () => {
    for (let i = 0; i < 20; i++) recordDevEmail({ to: "a@b.test", subject: "s", text: "t" });
    const list = getDevEmails();
    expect(new Set(list.map((e) => e.id)).size).toBe(20);
    for (const e of list) expect(new Date(e.sentAt).toISOString()).toBe(e.sentAt);
  });

  test("it lives on globalThis, so a hot reload (which re-evaluates the module) does not empty it", () => {
    recordDevEmail({ to: "a@b.test", subject: "kept", text: "t" });
    const held = (globalThis as unknown as { __devEmailInbox?: { subject: string }[] }).__devEmailInbox;
    expect(held?.[0].subject).toBe("kept");
  });

  test("a huge body is truncated, so the buffer can't become a memory leak", () => {
    const stored = recordDevEmail({ to: "a@b.test", subject: "big", text: "x".repeat(MAX_DEV_EMAIL_TEXT * 3) });
    expect(stored.text.length).toBeLessThan(MAX_DEV_EMAIL_TEXT + 50);
    expect(stored.text).toContain("[truncated]");
    const small = recordDevEmail({ to: "a@b.test", subject: "small", text: "hello" });
    expect(small.text).toBe("hello");
  });

  test("clear empties it", () => {
    recordDevEmail({ to: "a@b.test", subject: "s", text: "t" });
    clearDevEmails();
    expect(getDevEmails()).toEqual([]);
  });
});
