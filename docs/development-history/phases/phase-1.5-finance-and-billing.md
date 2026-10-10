# Phase 1.5 — Finance, Invoicing & Dual-Mode Paystack Integration

**Status: BUILT & VERIFIED (2026-10-10); Unit (22/22), API (9/9), Integration & RLS (66/66) all green.**
Branch: `claude/phase-1-5-finance` (merged into `fork/claude/phase-1-3-attendance` via PR #14).
Design of record: `docs/tasks/0004-phase-1-5-finance-and-billing.md`.
Roadmap: `docs/development-history/roadmap-breakdown.md` §1.5.

---

## What this delivers

| Step | Scope | What |
|---|---|---|
| Schema & Migration | DB / RLS | `prisma/schema/finance.prisma` (`FeeStructure`, `Invoice`, `InvoiceDiscount`, `Payment`, `PaymentWebhookEvent`, `InvoiceStatus`, `PaymentProvider`, `PaymentStatus`); migration `20261018090000_phase_1_5_finance_and_billing` applied to `octalve_edu` and `octalve_edu_test` with full RLS `ENABLE` & `FORCE` and runtime grants |
| Pure Rules | Domain | `src/lib/finance/rules.ts` (Naira / Kobo conversions, decimal arithmetic via Prisma Decimal, status resolution `UNPAID` / `PARTIALLY_PAID` / `PAID` / `WAIVED`, HMAC SHA-512 Paystack webhook validation) |
| API & Service | HTTP / Envelopes | `src/lib/finance/http.ts`, `src/lib/finance/service.ts`, `src/lib/finance/paystack.ts`, `GET/POST /api/v1/schools/[code]/finance/fee-structures`, `GET/POST /api/v1/schools/[code]/finance/invoices`, `GET/PATCH /api/v1/schools/[code]/finance/invoices/[id]`, `POST /api/v1/schools/[code]/finance/invoices/[id]/pay`, `POST /api/v1/finance/webhooks/paystack` |
| UI & Screens | Client Components | `src/components/finance/InvoicesDashboard.tsx`, `FeeStructuresPanel.tsx`, `InvoiceDetailView.tsx`, `PaystackMockModal.tsx` |
| Tests | Playwright | `tests/unit/finance-rules.spec.ts`, `tests/unit/finance-paystack.spec.ts`, `tests/api/finance.spec.ts`, verified against `tests/integration/rls.spec.ts` |

---

## Key Technical Decisions & Invariants
1. **Dual-Mode Paystack Integration:** In sandbox/dev environments without real API credentials, `PAYSTACK_MOCK_MODE=true` activates an instant interactive test payment flow, while production securely verifies HMAC signatures and initializes real Paystack checkout sessions.
2. **Idempotent Webhook Processing:** `PaymentWebhookEvent` records incoming transaction events by `providerRef` and rejects duplicates before triggering tenant-isolated ledger updates.
3. **Decimal Precision:** All fee structures, item prices, discounts, and payments are stored using `Decimal(12, 2)` preventing any floating-point truncation bugs.
4. **Automated Status Reconciliation:** Adding or verifying a payment triggers atomic balance computation that updates invoice state (`UNPAID` -> `PARTIALLY_PAID` -> `PAID`).
