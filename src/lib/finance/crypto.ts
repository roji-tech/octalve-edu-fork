import crypto from "node:crypto";

/**
 * Validates a Paystack webhook signature header against the raw request body.
 * Paystack computes HMAC-SHA512 using the secret key over the exact raw body.
 *
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 * Refuses re-stringified or altered body payloads.
 */
export function verifyPaystackSignature(rawBody: string | Buffer, signatureHeader: string | null | undefined, secretKey: string): boolean {
  if (!signatureHeader || !secretKey) {
    return false;
  }

  const cleanSignature = signatureHeader.trim().toLowerCase();
  if (cleanSignature.length === 0) {
    return false;
  }

  const hmac = crypto.createHmac("sha512", secretKey);
  const bodyBuffer = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  hmac.update(bodyBuffer);
  const expectedSignature = hmac.digest("hex").toLowerCase();

  const expectedBuf = Buffer.from(expectedSignature, "utf8");
  const receivedBuf = Buffer.from(cleanSignature, "utf8");

  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Computes a deterministic SHA-256 hash of the exact raw webhook body.
 * Stored in PaymentWebhookEvent.rawPayloadHash to maintain audit trail without
 * storing raw PII or secret payment details in database logs.
 */
export function computePayloadHash(rawBody: string | Buffer): string {
  const bodyBuffer = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return crypto.createHash("sha256").update(bodyBuffer).digest("hex");
}
