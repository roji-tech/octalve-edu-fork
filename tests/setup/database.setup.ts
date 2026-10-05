import { execFileSync } from "node:child_process";
import { test as setup } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { APP_DB_ROLE, TEST_APP_DATABASE_URL, TEST_DATABASE_NAME, TEST_DATABASE_URL } from "../support/env";
import { db, resetDatabase } from "../support/db";

// Runs once, first, before any suite that needs a database (the other projects
// depend on this one). Creates the *_test database if it doesn't exist yet,
// applies every migration to it exactly as production would (`migrate deploy`,
// never `db push`), and empties it.
setup("test database is created, migrated and empty", async () => {
  setup.setTimeout(120_000);

  if (!/^[A-Za-z0-9_]+$/.test(TEST_DATABASE_NAME)) {
    throw new Error(`Unsafe test database name: ${TEST_DATABASE_NAME}`);
  }

  const maintenanceUrl = new URL(TEST_DATABASE_URL);
  maintenanceUrl.pathname = "/postgres";
  const admin = new PrismaClient({ datasourceUrl: maintenanceUrl.toString() });
  try {
    // The admin arranges fixtures across schools, so row-level security must not apply to it. Say exactly how to fix it
    // when it does — a suite that quietly ran as a restricted admin would fail in confusing ways.
    const [me] = await admin.$queryRaw<{ rolname: string; bypass: boolean; createrole: boolean }[]>`
      SELECT rolname, (rolsuper OR rolbypassrls) AS bypass, (rolsuper OR rolcreaterole) AS createrole
        FROM pg_roles WHERE rolname = current_user`;
    if (!me.bypass) {
      throw new Error(
        `The test admin role "${me.rolname}" is subject to row-level security, so it cannot arrange fixtures. As a superuser run:\n\n  ALTER ROLE ${me.rolname} BYPASSRLS;\n\n(the docker compose role is already a superuser.)`,
      );
    }
    const roleExists = (await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${APP_DB_ROLE}`).length > 0;
    if (!roleExists) {
      if (!me.createrole) {
        throw new Error(
          `The runtime role "${APP_DB_ROLE}" does not exist and "${me.rolname}" cannot create it. As a superuser run:\n\n  CREATE ROLE ${APP_DB_ROLE} LOGIN PASSWORD '${APP_DB_ROLE}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;\n`,
        );
      }
      await admin.$executeRawUnsafe(`CREATE ROLE ${APP_DB_ROLE} LOGIN PASSWORD '${APP_DB_ROLE}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    }
    const exists = await admin.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM pg_database WHERE datname = ${TEST_DATABASE_NAME}`;
    if (exists.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
    }
    await admin.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${TEST_DATABASE_NAME}" TO ${APP_DB_ROLE}`);
  } finally {
    await admin.$disconnect();
  }

  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    // The migrator (the admin) owns the tables and runs the migrations; the migration grants the runtime role its
    // privileges (app_grant_runtime_privileges).
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DIRECT_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });

  // The runtime role must be able to connect and must really be restricted — checked HERE, once, so a broken role setup
  // is one clear failure instead of a hundred confusing ones.
  const app = new PrismaClient({ datasourceUrl: TEST_APP_DATABASE_URL });
  try {
    const [row] = await app.$queryRaw<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (row.rolsuper || row.rolbypassrls) {
      throw new Error(`The runtime role "${row.rolname}" bypasses row-level security (superuser: ${row.rolsuper}, BYPASSRLS: ${row.rolbypassrls}); it must not.`);
    }
  } finally {
    await app.$disconnect();
  }

  await resetDatabase();
  await db.$disconnect();
});
