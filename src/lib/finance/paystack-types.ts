export interface InitializePaymentParams {
  email: string;
  amountInKobo: number;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface InitializePaymentResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface VerifyTransactionResult {
  status: "success" | "failed" | "abandoned";
  reference: string;
  amountInKobo: number;
  paidAt?: Date;
  channel?: string;
  currency: string;
  gatewayResponse?: string;
}

export interface PaystackGateway {
  initializePayment(params: InitializePaymentParams): Promise<InitializePaymentResult>;
  verifyTransaction(reference: string): Promise<VerifyTransactionResult>;
}
