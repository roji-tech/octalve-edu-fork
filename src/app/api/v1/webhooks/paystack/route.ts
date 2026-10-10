import { NextRequest, NextResponse } from "next/server";
import { processPaystackWebhook } from "@/lib/finance/service";

// POST /api/v1/webhooks/paystack
// Public webhook endpoint for Paystack payment notifications.
// Always returns 200 OK after logging the delivery attempt.
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-paystack-signature");
    const secretKey = process.env.PAYSTACK_SECRET_KEY || "test_mock_secret_key";

    const result = await processPaystackWebhook(rawBody, signature, secretKey);

    return NextResponse.json({
      received: true,
      status: result.status,
      eventId: result.eventId,
      ...(result.duplicate ? { duplicate: true } : {}),
    });
  } catch (err: unknown) {
    // Webhook endpoints must not return 500 to prevent continuous provider retries
    const message = err instanceof Error ? err.message : "Webhook processing error";
    return NextResponse.json({ received: true, error: message }, { status: 200 });
  }
}
