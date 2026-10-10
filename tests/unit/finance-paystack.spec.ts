import { test, expect } from "@playwright/test";
import { getPaystackClient, MockPaystackGateway, RealPaystackGateway, mockPaystack } from "@/lib/finance/paystack";

test.describe("finance paystack: mock and dual-mode client factory", () => {
  const originalEnv = { ...process.env };

  test.afterEach(() => {
    process.env = { ...originalEnv };
    mockPaystack.clear();
  });

  test("MockPaystackGateway initializes transactions and simulates payments", async () => {
    const mock = new MockPaystackGateway();
    const init = await mock.initializePayment({
      email: "student@octalve.internal",
      amountInKobo: 5000000,
      reference: "ref_test_123",
    });

    expect(init.reference).toBe("ref_test_123");
    expect(init.authorizationUrl).toContain("ref_test_123");

    // Initially abandoned
    const status1 = await mock.verifyTransaction("ref_test_123");
    expect(status1.status).toBe("abandoned");

    // Simulate successful payment
    mock.simulatePaymentCompletion("ref_test_123", "success");
    const status2 = await mock.verifyTransaction("ref_test_123");
    expect(status2.status).toBe("success");
    expect(status2.amountInKobo).toBe(5000000);
    expect(status2.paidAt).toBeInstanceOf(Date);
  });

  test("getPaystackClient returns MockPaystackGateway in non-production when key is unset", () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";

    const client = getPaystackClient();
    expect(client).toBeInstanceOf(MockPaystackGateway);
  });

  test("getPaystackClient throws PAYSTACK_NOT_CONFIGURED in production when key is unset", () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.FORCE_MOCK_PAYSTACK;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";

    expect(() => getPaystackClient()).toThrow(/PAYSTACK_NOT_CONFIGURED/);
    try {
      getPaystackClient();
    } catch (err: unknown) {
      expect((err as { code?: string }).code).toBe("PAYSTACK_NOT_CONFIGURED");
    }
  });

  test("getPaystackClient returns RealPaystackGateway when key is provided", () => {
    delete process.env.FORCE_MOCK_PAYSTACK;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const client = getPaystackClient("sk_live_1234567890abcdef");
    expect(client).toBeInstanceOf(RealPaystackGateway);
  });
});
