import "../support/env";
import { test, expect } from "@playwright/test";
import { describeUserAgent } from "@/lib/auth/user-agent";
import { maskEmail } from "@/lib/auth/mask-email";
import { checkName, NAME_MAX_LENGTH } from "@/lib/auth/profile-policy";
import { relativeTime } from "@/lib/relative-time";

// Pure helpers behind the account page's self-service cards (plan §0.5.E).

test.describe("describeUserAgent", () => {
  const cases: [string, string][] = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Chrome on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1", "Chrome on iPhone"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "Samsung Internet on Android"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0", "Opera on Windows"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Chrome on ChromeOS"],
  ];
  for (const [ua, expected] of cases) test(`${expected}`, () => expect(describeUserAgent(ua)).toBe(expected));

  test("falls back kindly: a browser alone, a system alone, nothing at all", () => {
    expect(describeUserAgent("curl/8.5.0")).toBe("curl");
    expect(describeUserAgent("SomeBot (Windows)")).toBe("Windows");
    expect(describeUserAgent("")).toBe("Unknown device");
    expect(describeUserAgent(null)).toBe("Unknown device");
    expect(describeUserAgent(undefined)).toBe("Unknown device");
    expect(describeUserAgent("🤖".repeat(500))).toBe("Unknown device");
  });

  test("only the first 255 characters are looked at (a hostile header can't make it slow or odd)", () => {
    expect(describeUserAgent("x".repeat(300) + " Firefox/127.0")).toBe("Unknown device");
  });

  test("never returns markup: it is rendered as text, and what it returns comes from a fixed list", () => {
    expect(describeUserAgent("<script>alert(1)</script> Chrome/1 Windows")).toBe("Chrome on Windows");
  });
});

test.describe("maskEmail", () => {
  test("keeps the first character and the whole domain", () => {
    expect(maskEmail("amina@school.example")).toBe("a***@school.example");
    expect(maskEmail("x@y.test")).toBe("x***@y.test");
  });
  test("is safe with non-ASCII first characters (never splits a code point)", () => {
    expect(maskEmail("😀tester@x.test")).toBe("😀***@x.test");
    expect(maskEmail("éloïse@x.test")).toBe("é***@x.test");
  });
  test("anything not shaped like an address becomes ***", () => {
    for (const value of ["", "no-at-sign", "@nolocal.test", "nodomain@"]) expect(maskEmail(value)).toBe("***");
  });
  test("uses the LAST @ (a quoted local part may contain one)", () => {
    expect(maskEmail('"a@b"@x.test')).toBe('"***@x.test');
  });
});

test.describe("checkName", () => {
  const ok = (input: string) => {
    const result = checkName(input);
    if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
    return result.name;
  };
  const message = (input: string) => {
    const result = checkName(input);
    if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(input)}`);
    return result.message;
  };

  test("accepts real names from many scripts", () => {
    for (const name of ["Amina Yusuf", "Ọlámidé Adéṣànyà", "Chukwuemeka Okonkwo-Eze", "عبد الله جميو", "李小龍", "Zoë O'Brien", "María-José"]) {
      expect(ok(name)).toBe(name.normalize("NFC"));
    }
  });
  test("trims, collapses inner whitespace (including tabs and newlines), and normalises to NFC", () => {
    expect(ok("  Amina \t\n  Yusuf  ")).toBe("Amina Yusuf");
    expect(ok("Café")).toBe("Café"); // e + combining acute → é
  });
  test("empty or whitespace-only is refused", () => {
    expect(message("")).toMatch(/enter your name/i);
    expect(message("   \t ")).toMatch(/enter your name/i);
  });
  test(`the limit is ${NAME_MAX_LENGTH} CHARACTERS: exactly that passes, one more is refused, emoji count once`, () => {
    expect(ok("a".repeat(NAME_MAX_LENGTH))).toHaveLength(NAME_MAX_LENGTH);
    expect(message("a".repeat(NAME_MAX_LENGTH + 1))).toMatch(/at most 100/);
    expect([...ok("😀".repeat(NAME_MAX_LENGTH))]).toHaveLength(NAME_MAX_LENGTH);
    expect(message("😀".repeat(NAME_MAX_LENGTH + 1))).toMatch(/at most 100/);
  });
  test("control characters are refused (NUL, escape, bell, DEL, C1)", () => {
    for (const bad of ["A\u0000B", "A\u001bB", "A\u0007B", "A\u007fB", "A\u0085B"]) {
      expect(message(bad)).toMatch(/characters that can't be used/);
    }
  });
  test("bidirectional overrides are refused — they can make a name DISPLAY as something else", () => {
    for (const bad of ["Amina‮Yusuf", "‪Amina", "Amina⁦Yusuf", "Amina⁩", "Amina‬"]) {
      expect(message(bad)).toMatch(/characters that can't be used/);
    }
  });
  test("zero-width joiners are ALLOWED (needed by Persian, Arabic, Indic scripts and emoji sequences)", () => {
    expect(ok("می‌خواهم")).toContain("‌"); // ZWNJ
    expect(ok("👩‍🏫")).toContain("‍"); // ZWJ
  });
});

test.describe("relativeTime", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  test("under a minute is 'just now' (never '0 minutes ago')", () => {
    expect(relativeTime(ago(0), now, "en")).toBe("just now");
    expect(relativeTime(ago(59), now, "en")).toBe("just now");
  });
  test("minutes, hours, days, weeks, months, years", () => {
    expect(relativeTime(ago(60), now, "en")).toBe("1 minute ago");
    expect(relativeTime(ago(119), now, "en")).toBe("1 minute ago"); // truncated, not rounded up to 2
    expect(relativeTime(ago(5 * 60), now, "en")).toBe("5 minutes ago");
    expect(relativeTime(ago(3 * 3600), now, "en")).toBe("3 hours ago");
    expect(relativeTime(ago(86400), now, "en")).toBe("yesterday");
    expect(relativeTime(ago(3 * 86400), now, "en")).toBe("3 days ago");
    expect(relativeTime(ago(14 * 86400), now, "en")).toBe("2 weeks ago");
    expect(relativeTime(ago(60 * 86400), now, "en")).toBe("2 months ago");
    expect(relativeTime(ago(800 * 86400), now, "en")).toBe("2 years ago");
  });
  test("a time slightly in the future (clock skew) is 'just now', not 'in 0 minutes'", () => {
    expect(relativeTime(new Date(now + 20_000).toISOString(), now, "en")).toBe("just now");
  });
  test("garbage in, empty string out", () => {
    expect(relativeTime("not a date", now, "en")).toBe("");
  });
});
