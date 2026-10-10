import type { InitializePaymentParams, InitializePaymentResult, VerifyTransactionResult, PaystackGateway } from "./paystack-types";
import { mockPaystack } from "./mock-paystack";

export * from "./paystack-types";
export { MockPaystackGateway, mockPaystack } from "./mock-paystack";

export class RealPaystackGateway implements PaystackGateway {
  private secretKey: string;
  private baseUrl = "https://api.paystack.co";

  constructor(secretKey: string) {
    if (!secretKey) {
      throw new Error("Paystack secret key is required");
    }
    this.secretKey = secretKey;
  }

  async initializePayment(params: InitializePaymentParams): Promise<InitializePaymentResult> {
    const res = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: params.email,
        amount: params.amountInKobo,
        reference: params.reference,
        callback_url: params.callbackUrl,
        metadata: params.metadata,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Paystack initialize failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      status: boolean;
      message: string;
      data: {
        authorization_url: string;
        access_code: string;
        reference: string;
      };
    };

    if (!data.status || !data.data) {
      throw new Error(`Paystack initialization rejected: ${data.message}`);
    }

    return {
      authorizationUrl: data.data.authorization_url,
      accessCode: data.data.access_code,
      reference: data.data.reference,
    };
  }

  async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
    const res = await fetch(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Paystack verify failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      status: boolean;
      message: string;
      data: {
        status: string;
        reference: string;
        amount: number;
        paid_at?: string;
        channel?: string;
        currency: string;
        gateway_response?: string;
      };
    };

    if (!data.status || !data.data) {
      return {
        status: "failed",
        reference,
        amountInKobo: 0,
        currency: "NGN",
        gatewayResponse: data.message || "Failed verification",
      };
    }

    const statusMap: Record<string, "success" | "failed" | "abandoned"> = {
      success: "success",
      failed: "failed",
      abandoned: "abandoned",
    };

    return {
      status: statusMap[data.data.status] || "failed",
      reference: data.data.reference,
      amountInKobo: data.data.amount,
      paidAt: data.data.paid_at ? new Date(data.data.paid_at) : undefined,
      channel: data.data.channel,
      currency: data.data.currency,
      gatewayResponse: data.data.gateway_response,
    };
  }
}

/**
 * Factory for Paystack client respecting production and testing modes.
 *
 * CRITICAL RULE (Roadmap §1.5 T4):
 * In production, if PAYSTACK_SECRET_KEY is absent, throw PAYSTACK_NOT_CONFIGURED.
 * NEVER silently fall back to mock in production.
 */
export function getPaystackClient(secretKeyOverride?: string): PaystackGateway {
  const secretKey = secretKeyOverride || process.env.PAYSTACK_SECRET_KEY;
  const isProd = process.env.NODE_ENV === "production";
  const forceMock = process.env.FORCE_MOCK_PAYSTACK === "true";

  if (secretKeyOverride) {
    return new RealPaystackGateway(secretKeyOverride);
  }

  if (isProd) {
    if (!secretKey) {
      const err = new Error("PAYSTACK_NOT_CONFIGURED: Paystack secret key is missing in production environment");
      (err as unknown as { code: string }).code = "PAYSTACK_NOT_CONFIGURED";
      throw err;
    }
    if (forceMock) {
      return mockPaystack;
    }
    return new RealPaystackGateway(secretKey);
  }

  // In development and test environments:
  if (!secretKey || forceMock) {
    return mockPaystack;
  }

  return new RealPaystackGateway(secretKey);
}
