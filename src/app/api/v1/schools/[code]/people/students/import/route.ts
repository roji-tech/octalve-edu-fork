import { z } from "zod";
import { fail, ok } from "@/lib/api/envelope";
import { validate } from "@/lib/api/validate";
import { withAuth, type TenantAuthContext } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { WRITE_ROLES, peopleFailure } from "@/lib/people/http";
import { IMPORT_MAX_BYTES, importStudents } from "@/lib/people/import";

// POST /api/v1/schools/[code]/people/students/import  { csv, dryRun } — ADMIN only. `csv` is the file's text (UTF-8, at most 1 MiB and 1,000 students; the header names the
// columns: first_name, last_name, date_of_birth are required; middle_name, admission_no, campus, class, arm, session, guardian_name, guardian_phone, guardian_email,
// relationship are optional). ALL OR NOTHING: any problem — or `dryRun: true` — writes nothing and the answer is a report of every row. 200 with report.committed
// true means the students now exist; 200 with committed false is a dry run (or a report of problems for a real run: then `counts.errors` > 0).
// A dry run proves nothing to the server: a real run re-checks everything. Campus, class, arm and session are matched BY NAME inside this school.
/// A 1 MiB file, JSON-escaped, can approach twice its size (every CR and LF is two characters); the default 1 MiB body cap would refuse files the importer accepts.
const IMPORT_MAX_BODY_BYTES = IMPORT_MAX_BYTES * 2 + 1024;
const IMPORTS_PER_WINDOW = 12; // per administrator per school per 5 minutes: a dry run and a real run each count
const body = z.strictObject({
  csv: z.string({ error: "Send the file's text." }).max(IMPORT_MAX_BYTES * 2),
  dryRun: z.boolean({ error: "Say whether this is a dry run (true) or the real import (false)." }),
});

export const POST = withAuth(
  validate({ body, maxBodyBytes: IMPORT_MAX_BODY_BYTES }, async (_req, auth: TenantAuthContext, _ctx: unknown, { body: input }) => {
    if (!(await reserveAttempt(`people:import:${auth.tenant.tenantId}:${auth.userId}`, IMPORTS_PER_WINDOW))) {
      return fail("Too many imports. Please try again in a few minutes.", 429, "RATE_LIMITED");
    }
    const result = await importStudents(auth.tenant, auth.userId, input);
    return result.ok ? ok({ report: result.report }) : peopleFailure(result.reason, result.detail);
  }),
  { tenant: true, roles: WRITE_ROLES },
);
