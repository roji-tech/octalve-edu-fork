import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";

// "RLS is inert unless the role that connects actually has it enforced" (domain-implementation-plan.md §0.5.2, item 8).
// Policies do not apply to a superuser, to a role with BYPASSRLS, or — unless the table is FORCEd — to the table's owner,
// and `CREATE POLICY` succeeds regardless. A runtime connected as the migrator would therefore run with every policy
// silently doing nothing, and a naive test run as that same role would pass vacuously. So the app asks Postgres who it is.

export type RlsReport = { role: string; problems: string[] };

export async function checkRlsEnforcement(client: Pick<PrismaClient, "$queryRaw"> = prisma): Promise<RlsReport> {
  const [who] = await client.$queryRaw<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; owns_tables: boolean }[]>`
    SELECT r.rolname, r.rolsuper, r.rolbypassrls,
           COALESCE((SELECT bool_or(c.relowner = r.oid)
                       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND c.relkind = 'r'), false) AS owns_tables
      FROM pg_roles r WHERE r.rolname = current_user`;
  const unprotected = await client.$queryRaw<{ relname: string }[]>`
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`;

  const problems: string[] = [];
  if (who.rolsuper) problems.push(`the database role "${who.rolname}" is a superuser`);
  if (who.rolbypassrls) problems.push(`the database role "${who.rolname}" has BYPASSRLS`);
  if (who.owns_tables) problems.push(`the database role "${who.rolname}" OWNS the tables (it is the migrator, not the runtime role)`);
  for (const table of unprotected) problems.push(`table "${table.relname}" has a tenantId column but row-level security is not enabled and forced on it`);
  return { role: who.rolname, problems };
}

/// What to do about a report: nothing, say so once, or refuse to serve. Pure, so the whole matrix is tested.
export function rlsVerdict(report: RlsReport, env: { production: boolean; allowBypass: boolean }): "ok" | "warn" | "throw" {
  if (report.problems.length === 0) return "ok";
  return env.production && !env.allowBypass ? "throw" : "warn";
}

let checked: Promise<void> | null = null;

/// Run once per process before the first tenant resolution. A violation THROWS in production — every tenant route then
/// answers 500 loudly rather than serving data with no database-level isolation — unless `ALLOW_RLS_BYPASS=true` (an
/// explicit, logged escape hatch for a single-user machine). Elsewhere it warns once. A refusal, or a failure to even ask
/// (the database was briefly unreachable), is NOT remembered: the next request asks again, so a fixed configuration or a
/// recovered database is picked up without a restart, and one bad moment cannot poison the process.
export function assertRlsEnforced(client: Pick<PrismaClient, "$queryRaw"> = prisma): Promise<void> {
  checked ??= (async () => {
    const report = await checkRlsEnforcement(client);
    const verdict = rlsVerdict(report, { production: process.env.NODE_ENV === "production", allowBypass: process.env.ALLOW_RLS_BYPASS === "true" });
    if (verdict === "ok") return;
    const message = `Row-level security is NOT enforced for this connection: ${report.problems.join("; ")}. Connect the app as the unprivileged runtime role (DATABASE_URL = app_user; DIRECT_URL is for migrations only) — see .env.example.`;
    if (verdict === "throw") throw new Error(message);
    console.warn(`[RLS] ${message}${process.env.ALLOW_RLS_BYPASS === "true" ? " (ALLOW_RLS_BYPASS=true)" : ""}`);
  })().catch((error) => {
    checked = null;
    throw error;
  });
  return checked;
}

/// For tests.
export function resetRlsAssertionForTests(): void {
  checked = null;
}
