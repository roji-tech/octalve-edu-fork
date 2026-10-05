import { after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail } from "@/lib/api/envelope";
import { withAuth } from "@/lib/auth/with-auth";
import { reserveAttempt } from "@/lib/auth/rate-limit";
import { auditPersonEvent } from "@/lib/auth/audit";
import { checkName } from "@/lib/auth/profile-policy";

// PATCH /api/v1/account/profile  { name }                                              (plan §0.5.E)
// A person edits their own display name. The name is shown to other people (headers, member lists), so it is
// normalised and checked by the one rule in profile-policy.ts. Every change is audited, before and after.
const CHANGES_PER_WINDOW = 10; // per account per 5 minutes (every attempt counts — this is not a guessing target)

const schema = z.object({ name: z.string().max(1000) }); // a size bound only; the real rule is checkName

export const PATCH = withAuth(async (req, auth) => {
  if (!(await reserveAttempt(`profile:user:${auth.userId}`, CHANGES_PER_WINDOW))) {
    return fail("Too many changes. Please try again in a few minutes.", 429, "RATE_LIMITED");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return fail("Enter your name.", 400, "VALIDATION");
  const checked = checkName(parsed.data.name);
  if (!checked.ok) return fail(checked.message, 400, "VALIDATION");

  const before = await prisma.user.findUnique({ where: { id: auth.userId }, select: { name: true } });
  const user = await prisma.user.update({
    where: { id: auth.userId },
    data: { name: checked.name },
    select: { id: true, name: true, email: true },
  });

  if (before?.name !== user.name) {
    after(async () => {
      try {
        await auditPersonEvent(auth.userId, "PROFILE_UPDATED", { before: { name: before?.name ?? null }, after: { name: user.name } });
      } catch (error) {
        console.error("[profile] audit failed:", error instanceof Error ? error.message : error);
      }
    });
  }
  return ok({ user });
});
