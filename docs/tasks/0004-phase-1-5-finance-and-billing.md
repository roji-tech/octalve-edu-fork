# [TASK-0004]: Phase 1.5 — Finance, Invoicing & Paystack Integration

- **Period / Focus:** 2026-10-10 (Finance, Fee Structures, Invoices, Mock Paystack, HMAC Webhooks & Atomic Fulfilment)
- **Status:** Completed
- **Priority:** High
- **Assignee:** Claude Agent / Maintainer
- **Target Branch / PR:** `claude/phase-1-5-finance`
- **Started:** 2026-10-10 00:07:00 UTC
- **Ended:** 2026-10-10 08:45:00 UTC

> **How to tick:** change `[ ]` to `[x]`. The table shows the characters, not a clickable box.

---

## 1. Objective
Implement Phase 1.5 in Octalve Edu: Fee structures per class/period, idempotent invoice generation per student/period, Decimal Naira handling (kobo restricted to gateway client), dual-mode Paystack client (deterministic mock in dev/test, `PAYSTACK_NOT_CONFIGURED` fail-safe in production), tamper-resistant webhook validation (exact raw body HMAC-SHA512 with `timingSafeEqual`), atomic payment fulfilment using concurrency locking (`updateMany ... status PENDING`), rate-limited transaction verification, discount/waiver workflows, and receipt generation.

## 2. Context & Related Docs
- Canonical Reference: `docs/development-history/roadmap-breakdown.md` §1.5 & `domain-implementation-plan.md` lines 1897–1993.
- PRD Reference: `docs/PRD.md` §5 (Finance), §6 (Modules).
- Security Requirements: Server-side payment verification (`verifiedServerSide = true`), separate `PaymentWebhookEvent` log, rate-limited polling and webhook endpoints, strict IDOR controls (parents/guardians view only linked invoices).
- Preceding Work: Phase 1.2 (Students/Guardians), Phase 1.3 (Attendance), Phase 1.4 (Results & Audit).

---

## 3. Work Breakdown

### Sub-phase A: Schema & Migration (`finance.prisma`)
- [x] Create `prisma/schema/finance.prisma` with `FeeStructure`, `Invoice`, `InvoiceStatus`, `Payment`, `PaymentProvider`, `PaymentStatus`, `InvoiceDiscount`, `DiscountWorkflowMode`, `PaymentWebhookEvent`.
- [x] Add back-relations in `tenancy.prisma`, `people.prisma`, and `academics.prisma`.
- [x] Apply migration with PostgreSQL Row-Level Security (`forTenant()`, `app_user`), unique constraint `@@unique([provider, providerRef])`, and check constraints.
- [x] Deploy migration to `octalve_edu` and `octalve_edu_test` and run `prisma generate`.

### Sub-phase B: Pure Rules & Computation Engine
- [x] `src/lib/finance/rules.ts`: Currency conversion (Decimal Naira ↔ Integer Kobo), fee item aggregation, invoice status determination (`UNPAID`, `PARTIALLY_PAID`, `PAID`, `WAIVED`), discount calculation rules.
- [x] `src/lib/finance/crypto.ts`: Webhook signature computation & verification using `crypto.timingSafeEqual`, raw payload hashing (SHA-256) for audit.

### Sub-phase C: Gateway Client & Dual-Mode Paystack Engine
- [x] `src/lib/finance/mock-paystack.ts`: Deterministic mock Paystack simulator for dev and automated tests.
- [x] `src/lib/finance/paystack.ts`: Dual-mode client with environment guard (`PAYSTACK_NOT_CONFIGURED` in prod without keys, mock in test/dev).

### Sub-phase D: Domain Services & Atomic Concurrency
- [x] `src/lib/finance/service.ts`:
  - `generateInvoices`: idempotent batch invoice creation per student and academic period.
  - `initializePayment`: payment attempt creation and gateway checkout URL generation.
  - `fulfillPayment`: atomic payment fulfilment with `updateMany` concurrency lock and server-side verification check.
  - `processWebhook`: webhook signature verification, audit logging in `PaymentWebhookEvent`, and idempotent fulfilment trigger.
  - `applyDiscount`: audited waiver/discount application.
  - `getInvoiceReceipt`: receipt aggregation with institutional branding.
- [x] `src/lib/finance/http.ts`: Strict Zod request schemas and failure envelopes.

### Sub-phase E: API Endpoints
- [x] `GET/POST /api/v1/schools/[code]/finance/fee-structures`: Fee schedule management (`CAN_MANAGE_FINANCE`).
- [x] `GET/POST /api/v1/schools/[code]/finance/invoices`: Invoice query and batch generation.
- [x] `GET /api/v1/schools/[code]/finance/invoices/[id]`: Invoice detail with guardian IDOR protection.
- [x] `POST /api/v1/schools/[code]/finance/invoices/[id]/pay`: Initialize payment attempt.
- [x] `POST /api/v1/schools/[code]/finance/invoices/[id]/discount`: Apply fee waiver/discount.
- [x] `POST /api/v1/webhooks/paystack`: Unauthenticated public webhook endpoint (raw body verified).
- [x] `GET /api/v1/schools/[code]/finance/payments/[ref]/status`: Payment verification status.

### Sub-phase F: UI Components
- [x] `src/components/finance/FeeStructuresPanel.tsx`: Fee schedule configuration.
- [x] `src/components/finance/InvoicesDashboard.tsx`: Collection overview KPIs and filterable invoice roll.
- [x] `src/components/finance/InvoiceDetailView.tsx`: Invoice breakdown, Paystack checkout action, and printable receipt.
- [x] `src/components/finance/PaystackMockModal.tsx`: Simulator dialog for developer testing.

### Sub-phase G: Testing & Quality Gates
- [x] Unit tests for currency math, invoice status transitions, and raw HMAC validation.
- [x] Concurrency & security integration tests: 20 simultaneous fulfilments resolve to one; re-stringified body rejected; amount mismatch throws.
- [x] API tests: invoice generation, payment checkout, webhook handling, guardian IDOR isolation.
- [x] RLS catalog guard verification.
- [x] `pnpm typecheck && pnpm lint && pnpm format:check` clean.
- [x] Update tasks registers and commit.
