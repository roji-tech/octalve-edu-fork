import "../support/env";
import { HTTP_PORT, HTTP_URL } from "../support/env";
import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { uniqueIp } from "../support/db";
import { withEnv, type Vars } from "../support/with-env";
import { getEmailTransport, sendEmailQuietly } from "@/lib/email/transport";
import { resetEmail } from "@/lib/email/messages";
import { clearDevEmails, getDevEmails } from "@/lib/dev/email-inbox";
import { DELETE, GET } from "@/app/api/v1/dev/email-inbox/route";

// The `inbox` email transport and the routes behind the widget, called in-process with the environment set
// per test (the servers under test are production-shaped; the staging-mode server has its own API/browser specs).

const DEVELOPMENT: Vars = { APP_ENV: "development", DEV_TOOLS: "", DEV_TOOLS_TOKEN: "", EMAIL_TRANSPORT: undefined, RESEND_API_KEY: undefined };
const STAGING: Vars = { APP_ENV: "staging", DEV_TOOLS: "true", DEV_TOOLS_TOKEN: "staging-secret-token", EMAIL_TRANSPORT: undefined, RESEND_API_KEY: undefined };
const PRODUCTION: Vars = { APP_ENV: "production", DEV_TOOLS: "true", DEV_TOOLS_TOKEN: "staging-secret-token", EMAIL_TRANSPORT: undefined, RESEND_API_KEY: undefined };

const message = { to: "amina@school.test", subject: "Hello", text: "Body with a link https://example.test/x#token=SECRET-LINK" };

/// Silences and records console.log for one call.
async function capturingLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = original;
  }
}

test.beforeEach(() => clearDevEmails());

test.describe("choosing the transport", () => {
  test("an explicit EMAIL_TRANSPORT always wins — even with the dev tools on", async () => {
    await withEnv({ ...DEVELOPMENT, EMAIL_TRANSPORT: "file" }, async () => {
      await getEmailTransport().send({ ...message, to: "explicit-file@test.example" });
    });
    expect(getDevEmails()).toEqual([]); // went to the file, not the inbox
  });

  test("unset, with RESEND_API_KEY: resend (it then insists on EMAIL_FROM)", async () => {
    await withEnv({ ...DEVELOPMENT, RESEND_API_KEY: "re_test", EMAIL_FROM: undefined }, async () => {
      await expect(getEmailTransport().send(message)).rejects.toThrow(/RESEND_API_KEY and EMAIL_FROM/);
    });
    expect(getDevEmails()).toEqual([]);
  });

  test("unset, dev tools on (development): the inbox", async () => {
    await withEnv(DEVELOPMENT, async () => {
      const { lines } = await capturingLog(() => getEmailTransport().send(message));
      expect(lines).toHaveLength(1);
    });
    const [captured] = getDevEmails();
    expect(captured).toMatchObject({ to: message.to, subject: message.subject, text: message.text });
  });

  test("unset, dev tools on (staging with a token): the inbox", async () => {
    await withEnv(STAGING, () => sendEmailQuietly(message));
    expect(getDevEmails()).toHaveLength(1);
  });

  test("unset, dev tools OFF (production-shaped): the console — and nothing reaches the inbox", async () => {
    await withEnv({ ...PRODUCTION, NODE_ENV: "production" }, async () => {
      const { lines } = await capturingLog(() => getEmailTransport().send(message));
      expect(lines.join("\n")).toContain("SECRET-LINK"); // the console transport prints the whole message
    });
    expect(getDevEmails()).toEqual([]);
  });

  test("EMAIL_TRANSPORT=inbox while the dev tools are off is a loud failure, never a silent buffer", async () => {
    for (const env of [PRODUCTION, { ...STAGING, DEV_TOOLS_TOKEN: "" }, { ...DEVELOPMENT, DEV_TOOLS: "false" }]) {
      await withEnv({ ...env, EMAIL_TRANSPORT: "inbox" }, async () => {
        await expect(getEmailTransport().send(message)).rejects.toThrow(/needs the dev tools enabled/);
        const quietly = await (async () => {
          const original = console.error;
          console.error = () => undefined;
          try {
            return await sendEmailQuietly(message);
          } finally {
            console.error = original;
          }
        })();
        expect(quietly).toBe(false);
      });
    }
    expect(getDevEmails()).toEqual([]);
  });

  test("the log line names the recipient and subject but NEVER the body (a reset link stays out of logs)", async () => {
    await withEnv(DEVELOPMENT, async () => {
      const { lines } = await capturingLog(() => getEmailTransport().send(message));
      expect(lines[0]).toContain(message.to);
      expect(lines[0]).toContain(message.subject);
      expect(lines.join("\n")).not.toContain("SECRET-LINK");
      expect(lines.join("\n")).not.toContain("Body with a link");
    });
  });

  test("an unknown transport is still a loud error, and the message now lists inbox", async () => {
    await withEnv({ EMAIL_TRANSPORT: "carrier-pigeon" }, async () => {
      expect(() => getEmailTransport()).toThrow(/resend \| console \| file \| inbox/);
    });
  });

  test("the real password-reset email lands in the inbox with its link intact", async () => {
    await withEnv(DEVELOPMENT, async () => {
      await capturingLog(() => sendEmailQuietly(resetEmail("someone@test.example", "TOKEN123")));
    });
    const [captured] = getDevEmails();
    expect(captured.subject).toMatch(/Reset your .* password/);
    expect(captured.text).toContain(`${HTTP_URL}/reset-password#token=TOKEN123`);
  });
});

// --- the routes --------------------------------------------------------------------------------------------

type Opts = { method?: "GET" | "DELETE"; token?: string; origin?: string | null; ip?: string };
function request({ method = "GET", token, origin, ip = uniqueIp() }: Opts = {}) {
  const headers: Record<string, string> = {
    "x-forwarded-host": `localhost:${HTTP_PORT}`, // what the CSRF check compares Origin against
    "x-real-ip": ip,
  };
  if (token !== undefined) headers["x-dev-tools-token"] = token;
  if (origin !== null) headers.origin = origin ?? HTTP_URL;
  return new NextRequest(`${HTTP_URL}/api/v1/dev/email-inbox`, { method, headers });
}
const call = (handler: typeof GET, opts?: Opts) => handler(request(opts));
/// The body read ONCE: its raw text (to check nothing leaked) and its parsed JSON.
const read = async (res: Response) => {
  const text = await res.text();
  return { text, json: JSON.parse(text) };
};
const codeOf = async (res: Response) => (await read(res)).json.error?.code;
const seed = () => getEmailTransport().send({ ...message });

test.describe("GET / DELETE /api/v1/dev/email-inbox — where the dev tools are off", () => {
  test("production: 404 for both methods — even with DEV_TOOLS=true and the right token — and nothing is returned or cleared", async () => {
    await withEnv(DEVELOPMENT, async () => {
      await capturingLog(seed);
    });
    await withEnv({ ...PRODUCTION, NODE_ENV: "production" }, async () => {
      for (const token of [undefined, "staging-secret-token", "wrong"]) {
        const got = await call(GET, { token });
        expect(got.status).toBe(404);
        const body = await read(got);
        expect(body.json.error.code).toBe("NOT_FOUND");
        expect(body.text).not.toContain("SECRET-LINK");
        expect((await call(DELETE, { method: "DELETE", token })).status).toBe(404);
      }
    });
    expect(getDevEmails()).toHaveLength(1); // the DELETE did nothing
  });

  test("staging without a token configured, and development with DEV_TOOLS=false: 404 too", async () => {
    for (const env of [{ ...STAGING, DEV_TOOLS_TOKEN: "" }, { ...STAGING, DEV_TOOLS: "false" }, { ...DEVELOPMENT, DEV_TOOLS: "false" }]) {
      await withEnv(env, async () => {
        expect((await call(GET, { token: "staging-secret-token" })).status).toBe(404);
      });
    }
  });

  test("an unrecognised APP_ENV is production: 404", async () => {
    await withEnv({ ...STAGING, APP_ENV: "prod" }, async () => {
      expect((await call(GET, { token: "staging-secret-token" })).status).toBe(404);
    });
  });
});

test.describe("GET / DELETE /api/v1/dev/email-inbox — development (your own machine)", () => {
  test("open: the messages, newest first, uncacheable", async () => {
    await withEnv(DEVELOPMENT, async () => {
      await capturingLog(async () => {
        await getEmailTransport().send({ ...message, subject: "first" });
        await getEmailTransport().send({ ...message, subject: "second" });
      });
      const res = await call(GET);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body.data.mode).toBe("development");
      expect(body.data.emails.map((e: { subject: string }) => e.subject)).toEqual(["second", "first"]);
    });
  });

  test("DELETE clears — same-origin only (CSRF): cross-origin and origin-less requests are refused and clear nothing", async () => {
    await withEnv(DEVELOPMENT, async () => {
      await capturingLog(seed);
      for (const origin of ["https://evil.example", "http://evil-localhost:3100.example", null]) {
        const res = await call(DELETE, { method: "DELETE", origin });
        expect(res.status, String(origin)).toBe(403);
        expect(await codeOf(res)).toBe("CSRF");
      }
      expect(getDevEmails()).toHaveLength(1);
      const ok = await call(DELETE, { method: "DELETE" });
      expect(ok.status).toBe(200);
      expect(getDevEmails()).toEqual([]);
    });
  });
});

test.describe("GET / DELETE /api/v1/dev/email-inbox — staging (reachable by other people)", () => {
  test("no token → 401 TOKEN_REQUIRED and no data; a wrong one, a prefix of the right one, and the right one plus a character all fail", async () => {
    await withEnv(STAGING, async () => {
      await capturingLog(seed);
      const ip = uniqueIp();
      const none = await call(GET, { ip });
      expect(none.status).toBe(401);
      const noneBody = await read(none);
      expect(noneBody.json.error.code).toBe("TOKEN_REQUIRED");
      expect(noneBody.text).not.toContain("SECRET-LINK");
      for (const token of ["wrong", "staging-secret-toke", "staging-secret-tokenX", "STAGING-SECRET-TOKEN", " "]) {
        const res = await call(GET, { token, ip: uniqueIp() });
        expect(res.status, token).toBe(401);
        expect((await read(res)).text).not.toContain("SECRET-LINK");
      }
    });
  });

  test("the right token → 200, with the messages and the mode, uncacheable", async () => {
    await withEnv(STAGING, async () => {
      await capturingLog(seed);
      const res = await call(GET, { token: "staging-secret-token" });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body.data.mode).toBe("staging");
      expect(body.data.emails).toHaveLength(1);
    });
  });

  test("a surrounding-whitespace token configured by the operator still matches the trimmed secret", async () => {
    await withEnv({ ...STAGING, DEV_TOOLS_TOKEN: "  spaced-token  " }, async () => {
      expect((await call(GET, { token: "spaced-token" })).status).toBe(200);
    });
  });

  test("five wrong tokens from one IP shut it out — even the right token — for that IP only", async () => {
    await withEnv(STAGING, async () => {
      const ip = uniqueIp();
      for (let i = 0; i < 5; i++) expect((await call(GET, { token: `guess-${i}`, ip })).status).toBe(401);
      const limited = await call(GET, { token: "staging-secret-token", ip });
      expect(limited.status).toBe(429);
      expect(await codeOf(limited)).toBe("RATE_LIMITED");
      expect((await call(GET, { token: "staging-secret-token", ip: uniqueIp() })).status).toBe(200);
    });
  });

  test("a correct token is refunded (the widget polls every 4 s) and a missing one costs nothing", async () => {
    await withEnv(STAGING, async () => {
      const ip = uniqueIp();
      for (let i = 0; i < 4; i++) await call(GET, { token: `guess-${i}`, ip });
      for (let i = 0; i < 20; i++) expect((await call(GET, { token: "staging-secret-token", ip })).status).toBe(200);
      for (let i = 0; i < 20; i++) expect((await call(GET, { ip })).status).toBe(401); // never reaches the limiter
      expect((await call(GET, { token: "staging-secret-token", ip })).status).toBe(200);
    });
  });

  test("DELETE needs the token AND a same-origin request", async () => {
    await withEnv(STAGING, async () => {
      await capturingLog(seed);
      expect((await call(DELETE, { method: "DELETE" })).status).toBe(401);
      expect((await call(DELETE, { method: "DELETE", token: "wrong" })).status).toBe(401);
      expect((await call(DELETE, { method: "DELETE", token: "staging-secret-token", origin: "https://evil.example" })).status).toBe(403);
      expect(getDevEmails()).toHaveLength(1);
      expect((await call(DELETE, { method: "DELETE", token: "staging-secret-token" })).status).toBe(200);
      expect(getDevEmails()).toEqual([]);
    });
  });
});
