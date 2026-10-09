import "../support/env";
import { NextRequest } from "next/server";
import { test, expect } from "@playwright/test";
import { HTTP_PORT, HTTP_URL } from "../support/env";
import { db, resetDatabase, seedInstance } from "../support/db";
import { withEnv } from "../support/with-env";
import { POST as setup } from "@/app/api/v1/setup/route";

// Plan "Build design — Phase 1.2", decision P1: the kind of school a new school is comes from DEFAULT_SCHOOL_TYPE, read by the setup route on the
// server. (The refusal of a body that names a type is over HTTP in tests/api/setup.spec.ts; the parsing of the value is unit-tested.)

const post = (n: number) =>
  setup(
    new NextRequest(`${HTTP_URL}/api/v1/setup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: HTTP_URL,
        host: `localhost:${HTTP_PORT}`,
        "x-real-ip": `10.9.${Math.floor(Math.random() * 250)}.${n}`,
      },
      body: JSON.stringify({
        schoolName: "Type Test School",
        name: "Amina Yusuf",
        email: `amina${n}@type.test`,
        password: "Str0ng-enough-pw",
      }),
    }),
  );

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await resetDatabase();
  await seedInstance(); // leave the database usable for whatever runs next
});

for (const [value, expected] of [
  [undefined, "K12"],
  ["", "K12"],
  ["HIGHER_ED", "HIGHER_ED"],
  ["VOCATIONAL", "VOCATIONAL"],
] as const) {
  test(`DEFAULT_SCHOOL_TYPE=${JSON.stringify(value)} makes a ${expected} school`, async () => {
    await resetDatabase(); // the wizard only exists on a fresh install
    await withEnv({ DEPLOYMENT_MODE: "solo", DEFAULT_SCHOOL_TYPE: value }, async () => {
      const res = await post(1);
      expect(res.status).toBe(201);
    });
    expect((await db.tenant.findFirstOrThrow()).schoolType).toBe(expected);
  });
}

test("a mistyped DEFAULT_SCHOOL_TYPE stops setup with a 500 and writes nothing — the wizard stays open", async () => {
  await resetDatabase();
  await withEnv({ DEPLOYMENT_MODE: "solo", DEFAULT_SCHOOL_TYPE: "vocational" }, async () => {
    const res = await post(2);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("SERVER_CONFIG");
  });
  expect(await db.tenant.count()).toBe(0);
  expect(await db.user.count()).toBe(0);
  expect(await db.systemSettings.count({ where: { setupComplete: true } })).toBe(0);
});
