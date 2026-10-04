import { NextRequest } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok, fail } from "@/lib/api/envelope";
import { validateCSRF } from "@/lib/auth/csrf";
import { reserveAttempt, refundAttempt, getClientIp } from "@/lib/auth/rate-limit";
import { hashPassword } from "@/lib/auth/password";
import { checkNewPassword } from "@/lib/auth/password-policy";
import { slugifyTenantCode, isValidTenantCode } from "@/lib/tenant/validate-code";

// Solo-only (PRD §4's "one-time setup wizard" onboarding row). SaaS tenants
// are created by the future self-serve signup flow, not this — so the whole
// route is a 404 outside Solo, not just a UI redirect.
function requireSoloMode(): boolean {
  return process.env.DEPLOYMENT_MODE === "solo";
}

const setupSchema = z.object({
  schoolName: z.string().trim().min(1, "School name is required"),
  name: z.string().trim().min(1, "Administrator name is required"),
  email: z.string().trim().email("Valid email address is required").toLowerCase(),
  password: z.string().superRefine((value, ctx) => {
    const problem = checkNewPassword(value); // the one shared rule (setup, reset, change)
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }),
  setupToken: z.string().optional(),
});

/**
 * GET /api/v1/setup
 * Public. Returns whether the Solo instance's first-run setup is complete.
 */
export async function GET() {
  if (!requireSoloMode()) {
    return fail("Not found", 404, "NOT_FOUND");
  }

  try {
    const settings = await prisma.systemSettings.findUnique({
      where: { id: "global" },
    });

    return ok({
      setupComplete: !!settings?.setupComplete,
      requiresToken: Boolean(process.env.SETUP_TOKEN),
    });
  } catch (err) {
    console.error("[SETUP_STATUS_ERROR]", err);
    // Fail open on a DB blip so a deployer isn't locked out of their own
    // bootstrap step by a transient connection error (same call proplity's
    // wizard makes for the equivalent case).
    return ok({
      setupComplete: false,
      requiresToken: Boolean(process.env.SETUP_TOKEN),
    });
  }
}

/**
 * POST /api/v1/setup
 * One-time bootstrap: creates the Solo instance's single Tenant and its
 * first ADMIN. Guarded by CSRF + IP rate limiting + optional SETUP_TOKEN +
 * an atomic conditional update (only one concurrent request can ever flip
 * setupComplete false -> true) + an AuditLog row in the same transaction.
 */
export async function POST(req: NextRequest) {
  if (!requireSoloMode()) {
    return fail("Not found", 404, "NOT_FOUND");
  }

  if (!validateCSRF(req)) {
    return fail("Cross-origin request blocked", 403, "CSRF");
  }

  // Reserve-then-refund: the slot is taken now, before any slow work, and
  // handed back only on success (so failed attempts are what count).
  const clientIp = getClientIp(req);
  const limitKey = `setup:${clientIp}`;
  if (!(await reserveAttempt(limitKey))) {
    return fail(
      "Too many setup attempts from this IP. Please try again later.",
      429,
      "RATE_LIMITED",
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body", 400, "INVALID_BODY");
  }

  const parsed = setupSchema.safeParse(body);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid payload", 400, "VALIDATION");
  }

  const { schoolName, email, password, name, setupToken } = parsed.data;

  const expectedToken = process.env.SETUP_TOKEN;
  if (expectedToken) {
    const providedToken = req.headers.get("x-setup-token") || setupToken || "";
    const expectedBuf = Buffer.from(expectedToken);
    const providedBuf = Buffer.from(providedToken);

    const isValidToken =
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf);

    if (!isValidToken) {
      return fail(
        "Invalid or missing setup token. Check your server environment settings.",
        401,
        "BAD_SETUP_TOKEN",
      );
    }
  }

  try {
    const currentSettings = await prisma.systemSettings.findUnique({
      where: { id: "global" },
    });
    if (currentSettings?.setupComplete) {
      return fail("Setup has already been completed.", 409, "ALREADY_COMPLETE");
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return fail("An account with this email address already exists", 409, "DUPLICATE_EMAIL");
    }

    const passwordHash = await hashPassword(password);
    const userAgent = req.headers.get("user-agent") || "unknown";

    let tenantCode = slugifyTenantCode(schoolName);
    if (!isValidTenantCode(tenantCode)) {
      tenantCode = `school-${crypto.randomBytes(3).toString("hex")}`;
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.systemSettings.upsert({
        where: { id: "global" },
        update: {},
        create: { id: "global", setupComplete: false },
      });

      const updateResult = await tx.systemSettings.updateMany({
        where: { id: "global", setupComplete: false },
        data: { setupComplete: true },
      });

      if (updateResult.count === 0) {
        throw new Error("SETUP_ALREADY_COMPLETED");
      }

      const tenant = await tx.tenant.create({
        data: { code: tenantCode, name: schoolName },
      });

      const admin = await tx.user.create({
        data: { email, name, passwordHash },
      });

      await tx.tenantMembership.create({
        data: { userId: admin.id, tenantId: tenant.id, role: Role.ADMIN },
      });

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          actorUserId: admin.id,
          action: "SETUP_WIZARD_COMPLETE",
          targetType: "SystemSettings",
          targetId: "global",
          afterValue: { ip: clientIp, userAgent, email: admin.email, name: admin.name },
        },
      });

      return { tenant, admin };
    });

    console.log(
      `[FIRST_RUN_SETUP] Tenant "${result.tenant.name}" (${result.tenant.code}) administrator created: ${result.admin.email} from IP ${clientIp}`,
    );

    await refundAttempt(limitKey);

    return ok(
      {
        message: "Administrator account created successfully. Setup is now complete.",
        admin: { id: result.admin.id, name: result.admin.name, email: result.admin.email },
        tenant: { id: result.tenant.id, code: result.tenant.code, name: result.tenant.name },
      },
      {},
      201,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "SETUP_ALREADY_COMPLETED") {
      return fail("Setup has already been completed.", 409, "ALREADY_COMPLETE");
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return fail("A record with a conflicting unique value already exists.", 409, "CONFLICT");
    }
    console.error("[SETUP_POST_ERROR]", error);
    return fail("An unexpected error occurred during setup. Please try again.", 500, "INTERNAL");
  }
}
