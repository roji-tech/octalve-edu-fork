#!/usr/bin/env node
// Creates (if missing) the unprivileged runtime role and re-applies its privileges — for a database that did not come
// from `docker compose` (an existing dev database, a production one). domain-implementation-plan.md §0.5.2.
//
//   pnpm db:roles
//
// Connects with DIRECT_URL (the migrator / an administrator). Needs CREATEROLE to create the role; if the role
// already exists it only grants. Safe to run again. Prints the exact SQL to run by hand when it cannot.
import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env — the URLs may come from the environment
}

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DIRECT_URL (the migrator) in .env or the environment.");
  process.exit(2);
}
const appUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const role = process.env.APP_DB_ROLE ?? appUrl?.username ?? "app_user";
const password = process.env.APP_DB_PASSWORD ?? (appUrl ? decodeURIComponent(appUrl.password) : "app_user");
if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
  console.error(`Refusing an unusual role name: ${role}`);
  process.exit(2);
}
if (role !== "app_user") {
  console.error("The migration grants privileges to `app_user`; use that name (set DATABASE_URL accordingly).");
  process.exit(2);
}

const prisma = new PrismaClient({ datasourceUrl: url });
try {
  const [{ db }] = await prisma.$queryRaw`SELECT current_database() AS db`;
  const exists = (await prisma.$queryRaw`SELECT 1 FROM pg_roles WHERE rolname = ${role}`).length > 0;
  if (!exists) {
    try {
      await prisma.$executeRawUnsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password.replace(/'/g, "''")}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      console.log(`Created role ${role}.`);
    } catch (error) {
      console.error(`Could not create the role (${error.message}).\nAs a superuser, run:\n\n  CREATE ROLE ${role} LOGIN PASSWORD '<password>' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;\n\nthen run this again.`);
      process.exit(1);
    }
  }
  await prisma.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${db}" TO ${role}`);
  await prisma.$executeRawUnsafe("SELECT app_grant_runtime_privileges()");
  console.log(`${role} can connect to ${db} and holds the runtime privileges (data only: no DDL, no changes to the audit log).`);
} finally {
  await prisma.$disconnect();
}
