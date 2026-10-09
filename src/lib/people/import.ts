import crypto from "node:crypto";
import type { Relationship } from "@prisma/client";
import type { Tx } from "@/lib/tenant/for-tenant";
import type { TenantAuthContext } from "@/lib/auth/with-auth";
import { csvCell, parseCsv } from "@/lib/people/csv";
import {
  checkBirthDate,
  cleanAdmissionNo,
  cleanEmail,
  cleanOptional,
  cleanOptionalName,
  cleanPersonName,
  cleanPhone,
  duplicateKey,
  RELATIONSHIPS,
} from "@/lib/people/rules";
import { auditPeople, refuse, rollingBack, type PeopleResult } from "@/lib/people/results";
import { addGuardianWithin } from "@/lib/people/guardians";
import {
  enrolWithin,
  findDuplicate,
  insertStudent,
  lockStudents,
  studentWhere,
  STUDENT_ORDER,
  type StudentFilters,
} from "@/lib/people/students";

// Importing and exporting students as CSV (plan "Build design — Phase 1.2", decision P8).
//
// IMPORT is ALL OR NOTHING in ONE transaction under the school's student lock (two imports queue): every row is checked, every problem is reported, and if
// there is one — or if this is a dry run — the transaction is rolled back and nothing is written. A dry run runs the very same code as the real thing; the
// real one re-validates everything, because a dry run proves nothing to the server. Re-running a file is safe: a row that is already in the register (same
// admission number, name and birthday; or, with no number, a live student with that name and birthday) is SKIPPED and reported, never duplicated.
// Campus, class, arm and session are looked up BY NAME inside this school — never by id.
//
// EXPORT is the same filter as the student list, administrators only, capped, audited, with every cell neutralised against spreadsheet formulas (csv.ts).

type TenantCtx = TenantAuthContext["tenant"];

export const IMPORT_MAX_BYTES = 1024 * 1024;
export const IMPORT_MAX_ROWS = 1000;
export const IMPORT_MAX_CELL = 200;
export const EXPORT_MAX_ROWS = 10_000;
/// How many created/skipped rows the report lists in full (every ERROR row is always listed); the counts are always exact.
const REPORT_OK_ROWS = 100;

export const IMPORT_COLUMNS = [
  "first_name",
  "last_name",
  "middle_name",
  "date_of_birth",
  "admission_no",
  "campus",
  "class",
  "arm",
  "session",
  "guardian_name",
  "guardian_phone",
  "guardian_email",
  "relationship",
] as const;
type Column = (typeof IMPORT_COLUMNS)[number];
const REQUIRED: readonly Column[] = ["first_name", "last_name", "date_of_birth"];

export type ImportProblem = { column: Column | null; message: string };
export type ImportRow = {
  row: number;
  status: "created" | "skipped" | "error";
  name: string;
  admissionNo: string | null;
  note: string | null;
  problems: ImportProblem[];
};
export type ImportReport = {
  dryRun: boolean;
  /// True only when this was a real run with no problems: the students exist now.
  committed: boolean;
  counts: { rows: number; created: number; skipped: number; errors: number };
  headerProblems: string[];
  rows: ImportRow[];
  /// SHA-256 of the file as received — what the audit entry records instead of its content.
  fileHash: string;
};

/// Carries the finished report out of the transaction that must roll back.
class ImportRollback extends Error {
  constructor(readonly report: ImportReport) {
    super("import rolled back");
  }
}

const collapse = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

type Lookups = {
  campuses: { id: string; name: string }[];
  groups: { id: string; name: string; campusId: string | null }[];
  arms: { id: string; name: string; classGroupId: string }[];
  sessions: { id: string; label: string; campusId: string | null }[];
};

/// Candidates of a scoped thing (class group, session) that a student on `campusId` may use: school-wide ones, or their own campus's.
const fits = <T extends { campusId: string | null }>(items: T[], campusId: string | null) =>
  items.filter((item) => item.campusId === null || item.campusId === campusId);

type Parsed = {
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: string;
  admissionNo: string | null;
  campusId: string | null;
  place: { sessionId: string; classArmId: string } | null;
  guardian: { firstName: string; lastName: string; phone: string | null; email: string | null; relationship: Relationship } | null;
};

/// Reads one data row into clean values, or the problems with it. Pure given the lookups: no writes.
function readRow(
  cells: Record<Column, string>,
  lookups: Lookups,
  now: Date,
): { ok: true; value: Parsed } | { ok: false; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  const bad = (column: Column, message: string) => problems.push({ column, message });

  const firstName = cleanPersonName(cells.first_name);
  if (!firstName) bad("first_name", "Give a first name of 1 to 80 characters.");
  const lastName = cleanPersonName(cells.last_name);
  if (!lastName) bad("last_name", "Give a last name of 1 to 80 characters.");
  const middleName = cleanOptionalName(cells.middle_name);
  if (middleName === undefined) bad("middle_name", "A middle name is 1 to 80 characters, or leave it empty.");
  const birth = checkBirthDate(cells.date_of_birth, now);
  if (birth) bad("date_of_birth", "Write the date of birth as YYYY-MM-DD: a real day from 1900 up to today.");

  let admissionNo: string | null = null;
  if (cells.admission_no !== "") {
    admissionNo = cleanAdmissionNo(cells.admission_no);
    if (!admissionNo) bad("admission_no", "An admission number is 1 to 30 letters, digits, / - or . and starts with a letter or digit.");
  }

  let campusId: string | null = null;
  if (cells.campus !== "") {
    const found = lookups.campuses.filter((campus) => collapse(campus.name) === collapse(cells.campus));
    if (found.length === 1) campusId = found[0].id;
    else
      bad(
        "campus",
        found.length === 0 ? `No campus called "${cells.campus}" in this school.` : `More than one campus is called "${cells.campus}".`,
      );
  }

  let place: Parsed["place"] = null;
  const placeCells = [cells.class, cells.arm, cells.session];
  if (placeCells.some((cell) => cell !== "")) {
    if (placeCells.some((cell) => cell === "")) {
      for (const column of ["class", "arm", "session"] as const)
        if (cells[column] === "") bad(column, "To enrol a student give the class, the arm and the session together.");
    } else {
      const groups = fits(lookups.groups, campusId).filter((group) => collapse(group.name) === collapse(cells.class));
      const sessions = fits(lookups.sessions, campusId).filter((session) => collapse(session.label) === collapse(cells.session));
      if (groups.length !== 1)
        bad(
          "class",
          groups.length === 0
            ? `No class called "${cells.class}" fits this student.`
            : `More than one class called "${cells.class}" fits this student.`,
        );
      if (sessions.length !== 1)
        bad(
          "session",
          sessions.length === 0
            ? `No session called "${cells.session}" fits this student.`
            : `More than one session called "${cells.session}" fits this student.`,
        );
      if (groups.length === 1) {
        const arms = lookups.arms.filter((arm) => arm.classGroupId === groups[0].id && collapse(arm.name) === collapse(cells.arm));
        if (arms.length !== 1) bad("arm", `Class "${cells.class}" has no arm called "${cells.arm}".`);
        else if (sessions.length === 1) place = { sessionId: sessions[0].id, classArmId: arms[0].id };
      }
    }
  }

  let guardian: Parsed["guardian"] = null;
  const guardianCells = [cells.guardian_name, cells.guardian_phone, cells.guardian_email, cells.relationship];
  if (guardianCells.some((cell) => cell !== "")) {
    const tokens = cells.guardian_name.split(/\s+/).filter(Boolean);
    const relationship = RELATIONSHIPS.find((name) => name === cells.relationship.trim().toUpperCase());
    if (tokens.length < 2) bad("guardian_name", "Give the guardian's first and last name.");
    const phone = cleanOptional(cells.guardian_phone, cleanPhone);
    if (phone === undefined) bad("guardian_phone", "A phone number has 7 to 20 digits, spaces, + - or brackets.");
    const email = cleanOptional(cells.guardian_email, cleanEmail);
    if (email === undefined) bad("guardian_email", "Give a valid email address.");
    if (!relationship) bad("relationship", "Write mother, father, guardian or other.");
    const first = cleanPersonName(tokens.slice(0, -1).join(" "));
    const last = cleanPersonName(tokens[tokens.length - 1] ?? "");
    if (tokens.length >= 2 && (!first || !last)) bad("guardian_name", "A guardian's first and last names are each 1 to 80 characters.");
    if (first && last && phone !== undefined && email !== undefined && relationship)
      guardian = { firstName: first, lastName: last, phone, email, relationship };
  }

  if (problems.length > 0 || !firstName || !lastName || middleName === undefined) return { ok: false, problems };
  return { ok: true, value: { firstName, middleName, lastName, dateOfBirth: cells.date_of_birth, admissionNo, campusId, place, guardian } };
}

const REFUSAL_TEXT: Record<string, ImportProblem> = {
  POSSIBLE_DUPLICATE: { column: "first_name", message: "A student with this name and date of birth already exists." },
  ADMISSION_NUMBER_TAKEN: { column: "admission_no", message: "That admission number belongs to another student." },
  INVALID_SESSION: { column: "session", message: "This session does not fit the student's campus." },
  SESSION_CLOSED: { column: "session", message: "That session is closed or archived." },
  INVALID_ARM: { column: "arm", message: "This class does not fit the student's campus." },
  ALREADY_ENROLLED: { column: "class", message: "Already enrolled in a class for that session." },
};

export type ImportInput = { csv: string; dryRun: boolean; allowDuplicate?: boolean };

export async function importStudents(
  tenant: TenantCtx,
  actorUserId: string,
  input: ImportInput,
  now: Date = new Date(),
): Promise<PeopleResult<{ report: ImportReport }>> {
  const bytes = Buffer.byteLength(input.csv, "utf8");
  if (bytes > IMPORT_MAX_BYTES) return refuse("TOO_LARGE", { bytes, max: IMPORT_MAX_BYTES });
  const fileHash = crypto.createHash("sha256").update(input.csv).digest("hex");
  const empty = (headerProblems: string[]): ImportReport => ({
    dryRun: input.dryRun,
    committed: false,
    counts: { rows: 0, created: 0, skipped: 0, errors: 0 },
    headerProblems,
    rows: [],
    fileHash,
  });

  const parsed = parseCsv(input.csv);
  if (!parsed.ok) return { ok: true, report: empty([`Line ${parsed.line}: ${parsed.message}`]) };
  const [header = [], ...dataRows] = parsed.rows;
  if (dataRows.length > IMPORT_MAX_ROWS) return refuse("TOO_MANY_ROWS", { rows: dataRows.length, max: IMPORT_MAX_ROWS });

  const headerProblems: string[] = [];
  const names = header.map((name) => name.trim().toLowerCase());
  const known = new Set<string>(IMPORT_COLUMNS);
  for (const name of names)
    if (!known.has(name)) headerProblems.push(`Unknown column "${name}". The columns are: ${IMPORT_COLUMNS.join(", ")}.`);
  for (const name of new Set(names))
    if (names.filter((x) => x === name).length > 1) headerProblems.push(`The column "${name}" appears more than once.`);
  for (const column of REQUIRED) if (!names.includes(column)) headerProblems.push(`The column "${column}" is missing.`);
  if (headerProblems.length === 0 && dataRows.length === 0) headerProblems.push("The file has no students in it.");
  if (headerProblems.length > 0) return { ok: true, report: empty(headerProblems) };

  const { tenantId } = tenant;
  try {
    const result = await rollingBack(() =>
      tenant.run(async (tx): Promise<PeopleResult<{ report: ImportReport }>> => {
        await lockStudents(tx, tenantId);
        const lookups = await loadLookups(tx, tenantId);
        const rows: ImportRow[] = [];
        const counts = { rows: 0, created: 0, skipped: 0, errors: 0 };
        const guardians = new Map<string, string>(); // in-file siblings share one guardian record

        for (let index = 0; index < dataRows.length; index++) {
          const cellsRaw = dataRows[index];
          if (cellsRaw.every((cell) => cell.trim() === "")) continue; // a row of nothing but commas
          const rowNumber = index + 2; // the header is row 1, as in a spreadsheet
          counts.rows++;
          const record = {} as Record<Column, string>;
          for (const column of IMPORT_COLUMNS) record[column] = "";
          const problems: ImportProblem[] = [];
          if (cellsRaw.length !== names.length) {
            problems.push({ column: null, message: `Expected ${names.length} values but found ${cellsRaw.length}.` });
          } else {
            names.forEach((name, i) => {
              const cell = cellsRaw[i].trim();
              if (cell.length > IMPORT_MAX_CELL)
                problems.push({ column: name as Column, message: `Too long: at most ${IMPORT_MAX_CELL} characters.` });
              record[name as Column] = cell;
            });
          }
          const label = `${record.first_name} ${record.last_name}`.trim();
          const fail = (more: ImportProblem[]) => {
            counts.errors++;
            rows.push({
              row: rowNumber,
              status: "error",
              name: label,
              admissionNo: record.admission_no || null,
              note: null,
              problems: more,
            });
          };
          if (problems.length > 0) {
            fail(problems);
            continue;
          }
          const read = readRow(record, lookups, now);
          if (!read.ok) {
            fail(read.problems);
            continue;
          }
          const row = read.value;
          const fields = { firstName: row.firstName, middleName: row.middleName, lastName: row.lastName, dateOfBirth: row.dateOfBirth };

          // Already in the register? (Re-running a file must not duplicate anyone.)
          if (row.admissionNo) {
            const existing = await tx.studentRecord.findFirst({
              where: { tenantId, admissionNo: { equals: row.admissionNo, mode: "insensitive" } },
              select: { firstName: true, lastName: true, dateOfBirth: true, admissionNo: true, archivedAt: true },
            });
            if (existing) {
              const same =
                duplicateKey(existing.firstName, existing.lastName, existing.dateOfBirth.toISOString().slice(0, 10)) ===
                duplicateKey(row.firstName, row.lastName, row.dateOfBirth);
              if (same) {
                counts.skipped++;
                rows.push({
                  row: rowNumber,
                  status: "skipped",
                  name: label,
                  admissionNo: existing.admissionNo,
                  note: "Already in the register; nothing changed.",
                  problems: [],
                });
              } else {
                fail([{ column: "admission_no", message: "That admission number belongs to another student." }]);
              }
              continue;
            }
          } else {
            const twin = await findDuplicate(tx, tenantId, fields);
            if (twin) {
              counts.skipped++;
              rows.push({
                row: rowNumber,
                status: "skipped",
                name: label,
                admissionNo: twin.admissionNo,
                note: `Already in the register as ${twin.admissionNo}; nothing changed.`,
                problems: [],
              });
              continue;
            }
          }

          const created = await insertStudent(
            tx,
            tenantId,
            actorUserId,
            row.campusId,
            fields,
            row.admissionNo,
            now,
            Boolean(input.allowDuplicate),
          );
          if (!created.ok) {
            fail([REFUSAL_TEXT[created.reason] ?? { column: null, message: "This row could not be imported." }]);
            continue;
          }
          const studentId = created.row.id;
          const rowProblems: ImportProblem[] = [];
          if (row.place) {
            const enrolled = await enrolWithin(tx, tenant, actorUserId, { id: studentId, campusId: row.campusId }, row.place, now);
            if (!enrolled.ok)
              rowProblems.push(REFUSAL_TEXT[enrolled.reason] ?? { column: "class", message: "The student could not be enrolled." });
          }
          if (row.guardian) {
            const key = `${collapse(`${row.guardian.firstName} ${row.guardian.lastName}`)}|${row.guardian.phone ?? ""}|${row.guardian.email ?? ""}`;
            const known = guardians.get(key);
            const linked = await addGuardianWithin(
              tx,
              tenant,
              actorUserId,
              studentId,
              known
                ? { guardianId: known, relationship: row.guardian.relationship }
                : { ...row.guardian, relationship: row.guardian.relationship },
            );
            if (!linked.ok) rowProblems.push({ column: "guardian_name", message: "The guardian could not be added." });
            else if (!known) guardians.set(key, linked.link.guardian.id);
          }
          if (rowProblems.length > 0) {
            fail(rowProblems);
            continue;
          }
          counts.created++;
          rows.push({ row: rowNumber, status: "created", name: label, admissionNo: created.row.admissionNo, note: null, problems: [] });
        }

        const shown = [
          ...rows.filter((r) => r.status === "error"),
          ...rows.filter((r) => r.status !== "error").slice(0, REPORT_OK_ROWS),
        ].sort((x, y) => x.row - y.row);
        const report: ImportReport = { dryRun: input.dryRun, committed: false, counts, headerProblems: [], rows: shown, fileHash };
        if (input.dryRun || counts.errors > 0) throw new ImportRollback(report);
        await auditPeople(tx, tenantId, actorUserId, "StudentRecord", "STUDENTS_IMPORTED", fileHash.slice(0, 32), undefined, {
          rows: counts.rows,
          created: counts.created,
          skipped: counts.skipped,
          fileHash,
        });
        return { ok: true as const, report: { ...report, committed: true } };
      }),
    );
    return result as PeopleResult<{ report: ImportReport }>;
  } catch (error) {
    if (error instanceof ImportRollback) return { ok: true, report: error.report };
    throw error;
  }
}

async function loadLookups(tx: Tx, tenantId: string): Promise<Lookups> {
  const [campuses, groups, arms, sessions] = await Promise.all([
    tx.campus.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    tx.classGroup.findMany({ where: { tenantId, archivedAt: null }, select: { id: true, name: true, campusId: true } }),
    tx.classArm.findMany({
      where: { tenantId, archivedAt: null, classGroup: { archivedAt: null } },
      select: { id: true, name: true, classGroupId: true },
    }),
    tx.academicSession.findMany({ where: { tenantId, archivedAt: null }, select: { id: true, label: true, campusId: true } }),
  ]);
  return { campuses, groups, arms, sessions };
}

// --- export ----------------------------------------------------------------------------------------------------------------------

/// The students matching the list's own filters, as CSV text. Refused (`TOO_MANY_ROWS`) above 10,000 rows — narrow the filter. Audited in the same transaction
/// with WHO exported and with which filters (never the search text itself) — and how many rows. The class columns describe the enrolment in `filters.sessionId`.
export async function exportStudents(
  tenant: TenantCtx,
  actorUserId: string,
  filters: StudentFilters,
): Promise<PeopleResult<{ csv: string; count: number }>> {
  const where = studentWhere(tenant, filters);
  return tenant.run(async (tx) => {
    const rows = await tx.studentRecord.findMany({ where, orderBy: STUDENT_ORDER, take: EXPORT_MAX_ROWS + 1 });
    if (rows.length > EXPORT_MAX_ROWS) return refuse("TOO_MANY_ROWS", { max: EXPORT_MAX_ROWS, export: true });

    // Related rows are fetched in chunks of 1,000 ids — one query with ten thousand parents makes Postgres run out of stack ("stack depth limit exceeded"),
    // which the cap test found.
    const campusNames = new Map(
      (await tx.campus.findMany({ where: { tenantId: tenant.tenantId }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
    );
    const primaries = new Map<
      string,
      { relationship: string; guardian: { firstName: string; lastName: string; phone: string | null; email: string | null } }
    >();
    const places = new Map<string, { session: { label: string }; classArm: { name: string; classGroup: { name: string } } }>();
    for (let i = 0; i < rows.length; i += 1000) {
      const ids = rows.slice(i, i + 1000).map((row) => row.id);
      const links = await tx.guardianLink.findMany({
        where: { tenantId: tenant.tenantId, studentId: { in: ids }, isPrimary: true, status: { not: "REVOKED" } },
        include: { guardian: true },
      });
      for (const link of links) primaries.set(link.studentId, link);
      if (filters.sessionId) {
        const enrolments = await tx.studentEnrollment.findMany({
          where: { tenantId: tenant.tenantId, studentId: { in: ids }, sessionId: filters.sessionId },
          include: { session: { select: { label: true } }, classArm: { select: { name: true, classGroup: { select: { name: true } } } } },
        });
        for (const enrolment of enrolments) places.set(enrolment.studentId, enrolment);
      }
    }

    // The columns are EXACTLY the import's, in the same order, so a file exported here can be imported into another school (class, arm and session are filled
    // when the export names a session; guardian columns hold the primary contact).
    const lines: (string | null)[][] = [[...IMPORT_COLUMNS]];
    for (const row of rows) {
      const enrolment = places.get(row.id);
      const primary = primaries.get(row.id);
      const cells: Record<Column, string | null> = {
        first_name: row.firstName,
        last_name: row.lastName,
        middle_name: row.middleName,
        date_of_birth: row.dateOfBirth.toISOString().slice(0, 10),
        admission_no: row.admissionNo,
        campus: row.campusId ? (campusNames.get(row.campusId) ?? null) : null,
        class: enrolment?.classArm.classGroup.name ?? null,
        arm: enrolment?.classArm.name ?? null,
        session: enrolment?.session.label ?? null,
        guardian_name: primary ? `${primary.guardian.firstName} ${primary.guardian.lastName}` : null,
        guardian_phone: primary?.guardian.phone ?? null,
        guardian_email: primary?.guardian.email ?? null,
        relationship: primary?.relationship.toLowerCase() ?? null,
      };
      lines.push(IMPORT_COLUMNS.map((column) => cells[column]));
    }
    await auditPeople(tx, tenant.tenantId, actorUserId, "StudentRecord", "STUDENTS_EXPORTED", "export", undefined, {
      count: rows.length,
      filters: {
        status: filters.status,
        campusId: filters.campusId ?? null,
        sessionId: filters.sessionId ?? null,
        classArmId: filters.classArmId ?? null,
        notEnrolled: filters.notEnrolled ?? false,
        search: Boolean(filters.q?.trim()),
      },
    });
    return { ok: true as const, csv: lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n", count: rows.length };
  });
}
