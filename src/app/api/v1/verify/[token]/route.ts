import type { NextRequest } from "next/server";
import { ok, fail, noStore } from "@/lib/api/envelope";
import { getClientIp, reserveAttempt } from "@/lib/auth/rate-limit";
import { verifyPublicCredential } from "@/lib/results/service";

type Ctx = { params: Promise<{ token: string }> };

const IP_LIMIT = 60; // 60 attempts per 10 minutes per IP

// GET /api/v1/verify/[token]
// Unauthenticated public route for external validation of certificates and report cards.
export async function GET(req: NextRequest, ctx: Ctx) {
  return noStore(await handle(req, ctx));
}

async function handle(req: NextRequest, ctx: Ctx) {
  const ip = getClientIp(req);
  if (!(await reserveAttempt(`verify:token:ip:${ip}`, IP_LIMIT))) {
    return fail("Too many verification attempts. Please try again in a few minutes.", 429, "RATE_LIMITED");
  }

  const { token } = await ctx.params;
  if (!token || !/^[0-9a-f]{32}$/.test(token)) {
    return fail("Invalid verification token format.", 400, "INVALID_TOKEN");
  }

  const credential = await verifyPublicCredential(token);
  if (!credential) {
    return fail(
      "No published academic credential found for this verification token. Ensure the credential has been published by the institution.",
      404,
      "NOT_FOUND",
    );
  }

  return ok(credential);
}
