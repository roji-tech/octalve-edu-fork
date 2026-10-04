#!/usr/bin/env node
// Operator recovery for two-step verification (domain-implementation-plan.md §0.5.D).
//
//   pnpm mfa:reset -- <email>
//
// For a person who has lost BOTH their authenticator and their recovery codes: removes their second factor
// (credential, recovery codes, pending challenges), signs them out everywhere, and writes an audit row per
// school they belong to. They can then sign in with their password alone and set two-step verification up
// again. Run it on the server, as the person who administers it, after confirming who is asking — it is
// deliberately NOT reachable over HTTP (an admin screen comes with Users).
//
// Self-contained on purpose (plain Node + Prisma, no app imports): it must keep working when the app can't
// build.
import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env — DATABASE_URL may come from the environment
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length !== 1 || args[0].startsWith("-")) {
  console.error("Usage: pnpm mfa:reset -- <email>");
  process.exit(2);
}
const email = args[0].trim().toLowerCase();

const prisma = new PrismaClient();
try {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    console.error(`No account with the email ${email}.`);
    process.exitCode = 1;
  } else {
    const memberships = await prisma.tenantMembership.findMany({
      where: { userId: user.id },
      select: { tenantId: true },
    });
    const result = await prisma.$transaction(async (tx) => {
      const credentials = await tx.mfaCredential.deleteMany({ where: { userId: user.id } });
      const codes = await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.mfaChallenge.deleteMany({ where: { userId: user.id } });
      const sessions = await tx.session.deleteMany({ where: { userId: user.id } });
      if (credentials.count > 0 && memberships.length > 0) {
        await tx.auditLog.createMany({
          data: memberships.map((m) => ({
            tenantId: m.tenantId,
            actorUserId: user.id,
            action: "MFA_RESET",
            targetType: "User",
            targetId: user.id,
            reason: "Operator reset (pnpm mfa:reset)",
          })),
        });
      }
      return { had: credentials.count > 0, sessions: sessions.count, codes: codes.count };
    });
    if (!result.had) {
      console.log(`${email} did not have two-step verification on. Signed out ${result.sessions} session(s) anyway.`);
    } else {
      console.log(
        `Two-step verification removed for ${email} (${result.codes} recovery code(s) deleted); signed out ${result.sessions} session(s).`,
      );
    }
  }
} finally {
  await prisma.$disconnect();
}
