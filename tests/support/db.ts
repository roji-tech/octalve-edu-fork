import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient, Role } from "@prisma/client";
import { encryptSecret } from "@/lib/auth/mfa/secret-box";
import { generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode } from "@/lib/auth/mfa/recovery-codes";
import { generateTotpSecret, totpAt } from "@/lib/auth/mfa/totp";
import { TEST_DATABASE_NAME, TEST_DATABASE_URL } from "./env";

/// A client that is hard-wired to the TEST database (never the ambient
/// DATABASE_URL), plus a runtime check on every destructive helper.
export const db = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });

async function assertTestDatabase(): Promise<void> {
  const rows = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  const name = rows[0]?.name;
  if (name !== TEST_DATABASE_NAME || !name.endsWith("_test")) {
    throw new Error(`Refusing to touch database "${name}": tests only run against a *_test database.`);
  }
}

/// Empties every application table (everything except Prisma's own migration
/// ledger), so a spec can start from a true "fresh install". Discovers the
/// tables instead of listing them, so it can't go stale as phases add models.
export async function resetDatabase(): Promise<void> {
  await assertTestDatabase();
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename.replace(/"/g, '""')}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export const sha256Hex = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

// bcrypt at the real production cost is deliberately slow; hash each distinct
// test password once and reuse it.
const hashCache = new Map<string, string>();
async function hashOnce(password: string): Promise<string> {
  let hash = hashCache.get(password);
  if (!hash) {
    hash = await bcrypt.hash(password, 12);
    hashCache.set(password, hash);
  }
  return hash;
}

let counter = 0;
const runId = crypto.randomBytes(3).toString("hex");
export const uniqueEmail = (label = "user") => `${label}-${runId}-${++counter}@test.example`;

/// One RFC 1918 address per call. Sent as X-Real-IP (the header the servers
/// under test trust), it gives each test its own rate-limit buckets.
export function uniqueIp(): string {
  const n = ++counter + Math.floor(Math.random() * 60_000);
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export const DEFAULT_PASSWORD = "correct-horse-battery-9";

/// Marks the Solo instance as set up (so /login stops redirecting to /setup)
/// and returns a tenant to hang memberships on. Idempotent.
export async function seedInstance(schoolName = "Bright Future Academy") {
  await db.systemSettings.upsert({
    where: { id: "global" },
    update: { setupComplete: true },
    create: { id: "global", setupComplete: true },
  });
  const existing = await db.tenant.findFirst({ where: { name: schoolName } });
  if (existing) return existing;
  const code = `t-${crypto.randomBytes(4).toString("hex")}`;
  return db.tenant.create({ data: { code, name: schoolName } });
}

export type TestUser = { id: string; email: string; name: string; password: string; tenantId: string | null };

/// Creates a user with a real bcrypt hash. `role` adds a membership in a
/// (seeded) school; omit it for a user with no school. `password: null` makes
/// an invited-but-not-activated account (no passwordHash).
export async function createUser(
  opts: { email?: string; name?: string; password?: string | null; role?: Role } = {},
): Promise<TestUser> {
  const email = opts.email ?? uniqueEmail();
  const password = opts.password === undefined ? DEFAULT_PASSWORD : opts.password;
  const name = opts.name ?? "Amina Yusuf";
  const tenant = await seedInstance();

  const user = await db.user.create({
    data: { email, name, passwordHash: password === null ? null : await hashOnce(password) },
  });
  if (opts.role) {
    await db.tenantMembership.create({ data: { userId: user.id, tenantId: tenant.id, role: opts.role } });
  }
  return { id: user.id, email, name, password: password ?? "", tenantId: opts.role ? tenant.id : null };
}

export type TestMfa = { secret: Buffer; recoveryCodes: string[] };

/// Turns two-step verification ON for a user directly in the database — a confirmed credential and ten
/// recovery codes — for tests about SIGN-IN. (The enrolment flow itself is tested through the real routes.)
export async function enableMfa(userId: string): Promise<TestMfa> {
  const secret = generateTotpSecret();
  await db.mfaCredential.create({
    data: { userId, secretEnc: encryptSecret(secret, userId), confirmedAt: new Date() },
  });
  const recoveryCodes = generateRecoveryCodes();
  await db.mfaRecoveryCode.createMany({
    data: recoveryCodes.map((code) => ({ userId, codeHash: hashRecoveryCode(normaliseRecoveryCode(code)!) })),
  });
  return { secret, recoveryCodes };
}

/// The code an authenticator would show right now (`offsetSteps` shifts it by whole 30-second steps).
/// The server accepts the current step ±1, so offset 0 is safe even if a step boundary passes mid-request;
/// API tests that need a code the server must REFUSE use ±3 for the same reason.
export const codeFor = (secret: Buffer, offsetSteps = 0): string => totpAt(secret, Date.now(), offsetSteps);

/// Simulates time passing between sign-ins: forgets which step was last accepted, so the same current code
/// is acceptable again. (Tests about replay itself must NOT call this.)
export const rewindMfa = (userId: string) =>
  db.mfaCredential.update({ where: { userId }, data: { lastUsedStep: null } });

export { Role };
