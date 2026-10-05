# Octalve Edu — roadmap broken into sub-phases, tasks and steps

Written 2026-10-05. This is the **working map** under `domain-implementation-plan.md`: that document holds each phase's
*design* (models, rules, reasons); this one says **what to build, in what order, and how each piece is proven**. It does not
replace a design pass — every phase still gets its design written into the plan *before* code, and its record in
`phases/phase-X-….md` after.

**Conventions used below**
- **Phase → sub-phase → task → step.** IDs are stable (`0.5.2-B`, `1.3-T2`) so commits, PRs and tests can cite them.
- **Status:** ✅ built and verified · 🟡 built, verification partly done · ⛔ blocked (says on what) · ⬜ not started.
- **Every sub-phase ends the same way (the "definition of done"):** design in the plan → tests written first (unit /
  integration / api / e2e / axe, both themes) → code → full suite green → **mutation check** (inject the bug each test claims to
  catch; it must go red) → docs (plan "as built", phase record, `CLAUDE.md` rules, `tests/README.md`) → push the branch → PR to
  `master` **only when asked** (the maintainer merges).
- **Shared with AlEemaan** where the mechanism is shared (auth, UI language, permissions): built in Octalve Edu first, ported
  by reading the raw diff, logged as a divergence in both plan docs if they differ. AlEemaan's own map is in its repo.
- **Branch discipline:** stacked PRs merge into their *base branch*, not `master` — so each new branch is based on the latest
  unmerged branch (or `master` once merged) and its PR targets `master`.

---

## Where we are

| Phase | Status | Record |
| :-- | :-- | :-- |
| 0 Foundation | ✅ | `phases/phase-0-foundation.md` |
| 0.5.0 Setup wizard · 0.5.1 Auth | ✅ | `phase-0.5.0…`, `phase-0.5.1…` |
| 0.5.A Design language · 0.5.B CSP · 0.5.C Password reset · 0.5.D TOTP · 0.5.F Dev inbox | ✅ merged to `master` | `phase-0.5.A…F` |
| 0.5.E Account self-service | ✅ PR #7 open | `phase-0.5.E…` |
| **0.5.2 Tenant trust boundary** | ✅ application layer (`claude/tenant-trust-boundary`) **and row-level security** (`claude/tenant-rls`) built and verified | `phases/phase-0.5.2…` |
| 0.5.3 Shared API infrastructure | ✅ built and verified (`claude/tenant-trust-boundary`) | `phases/phase-0.5.3…` |
| **0.5.2-H App shell** | ✅ built and verified (`claude/app-shell-users`) | `phases/phase-0.5.2H-app-shell.md` |
| **0.5.4 Users pages & invitations** | 🟡 **built and WIP-committed** (`claude/app-shell-users`); **mutation pass (122 written, none run), a complete green run and the docs are outstanding** — handed to the local Claude Code session: `handoff/TAKEOVER.md` | plan; `handoff/` |
| Phase 1 … 5 | ⬜ | plan |

**No open blocker.** The RLS role was created with the maintainer's approval ("do both and run") and the whole suite now runs as `app_user`. Phase 1 may start once the shell and
the Users pages exist; **every Phase 1 table ships RLS in its own migration** (the catalog guard enforces it).

---

# Phase 0.5 — what remains

## 0.5.2 — Tenant trust boundary (closes the audit's most severe finding)
Design: plan §0.5.2 + "Build design for §0.5.2". Branch `claude/tenant-trust-boundary` (based on `claude/account-self-service`).

### 0.5.2-A — Verified tenant identity (the branded id) ✅ built
- **T1 `VerifiedTenantId`** — steps: (1) branded type; (2) the single constructor `trustedTenantId()` rejecting empty/oversized;
  (3) compile-time proof file (`with-auth.types.ts`: a raw string is refused); (4) ESLint `no-restricted-imports` confining
  `trustedTenantId` and the raw `prisma` client to an allow-list (**⬜ still to add**).
- **T2 `forTenant` / `forUser`** — steps: (1) one interactive transaction; (2) `set_config(name, $1, true)` (bind parameter,
  transaction-local); (3) `setTenantContext` / `setUserContext` for atomic provisioning; (4) tests: context visible inside,
  SQL-looking ids stay strings, **no leak on a one-connection pool**, rollback on error. ✅
- **T3 `resolveTenant`** — steps: (1) validate code; (2) Solo: assert exactly one tenant (else 500) then match code;
  (3) membership via user context; (4) one 403 for unknown / malformed / not-a-member; (5) tests incl. "ADMIN of A is not admin
  of B". ✅

### 0.5.2-B — `withAuth` with a verified school and roles ✅ built
- **T1** options `{ tenant: true, roles }` (type error without `tenant`), `auth.tenant.run()`; `permissions` stays `never` until §1.7.
- **T2** tests: in-process wrapper tests (member passes, other school / unknown / malformed / missing params → same 403,
  role allowed/denied, role held in *another* school doesn't count, empty `roles`, revoked session → 401, CSRF before tenant,
  Solo misconfiguration → 500). ✅

### 0.5.2-C — Existing code moves onto contexts ✅ built (verification of RLS side ⛔)
- **T1** `auditPersonEvent` (one row per school, each inside its tenant context) · **T2** `getUserMemberships` via user
  context (no campus names) · **T3** `completeSignIn` admin check via user context · **T4** setup wizard sets the tenant
  context in its own transaction · **T5** `scripts/mfa-reset.mjs` uses plain `set_config`.

### 0.5.2-D — School routes, pages and the front door 🟡
- **T1 API** `GET /api/v1/schools/[code]` ✅ (20 API tests incl. *every route under `/schools/` discovered from the file system
  and hit cross-tenant / signed-out / no-school*).
- **T2 pages** `/schools/[code]` workspace; `requireTenantPage`; `forbidden()` 403 view (`experimental.authInterrupts`) ✅ built.
- **T3 front door** `/dashboard` → one school redirects, several → picker, none → message ✅ built.
- **T4 existing tests adapt to the front door** (a one-school user now lands on `/schools/<code>`): `HOME_URL` helper applied;
  **⬜ steps:** (1) run the whole api/e2e/https suites; (2) fix the tests that assert dashboard *content* (`sign-in.spec`,
  `setup-handoff.spec`, a11y "dashboard" block); (3) confirm `forbidden()` returns a real 403 in the production build.
- **T5 new e2e** `front-door.spec.ts` on the SaaS server ⬜: one school → redirect; several → picker → click; none → message;
  code tampering → 403 view naming no school; ADMIN sees all campuses, staff only theirs; hostile school name renders inert.
- **T6 a11y** both themes + phone targets for picker, workspace, workspace-without-campus, 403 view ⬜.

### 0.5.2-E — Test harness for multi-school ✅ built
SaaS-mode **fifth server** (`SAAS_PORT` 3103), `createTenant` / `addMembership` / `removeCreatedTenants`, shared `withEnv`.
Rule recorded: Solo servers fail closed with two tenants, so multi-tenant specs run on the SaaS server and clean up.

### 0.5.2-F — Row-level security itself ✅ built and verified (branch `claude/tenant-rls`)
T1 infra (`docker/postgres/init/01-roles.sql`, `pnpm db:roles`, `DIRECT_URL`) ✅ · T2 migration `20261008090000_tenant_rls` (`app_tenant_id()` / `app_user_id()`; `ENABLE`+`FORCE` and `USING`+`WITH CHECK` on
`Campus`, `AuditLog` (append-only: no UPDATE/DELETE policy **and** the privileges revoked), `TenantMembership` (read: tenant **or** own user; write: tenant only); `app_grant_runtime_privileges()` and default privileges) ✅ ·
T3 harness (`TEST_APP_DATABASE_URL`; every server and in-process module runs as `app_user`; admin for fixtures; setup verifies and prints the exact fix) ✅ · T4 `assertRlsEnforced()` (+ a sixth, deliberately
misconfigured test server proving it is wired in) ✅ · T5 negative tests as `app_user` incl. the catalog guard (33 + 4) ✅ · T6 mutation pass (44; results in the phase record) ✅ · T7 docs ✅ — PR only when asked.

### 0.5.2-G — Mutation pass and docs for the application layer ⬜
Mutations for A–D (resolver trusting the URL, differing refusals, roles from the wrong school, Solo invariant removed, session
check after tenant check, forbidden view leaking the name, picker choosing the wrong school); full suites (unit, integration,
api, e2e desktop + phone, https); plan "as built"; `phases/phase-0.5.2-tenant-boundary.md`; trackers; `CLAUDE.md`.

### 0.5.2-H — The app shell ✅ built and verified (branch `claude/app-shell-users`)
T1 shell components + nav model driven by the role **in the school in view** ✅ · T2 account menu / sign-out ✅ · T3 `/account`, `/dashboard`, `/schools/[code]` and the 403 view moved into the shell ✅ · T4 responsive + axe both themes
(open states too) ✅ · T5 tests that sign out through the header adapted (`signOut` helper) ✅ · T6 record + 26 mutations ✅.

## 0.5.3 — Shared API infrastructure ⬜ (plan §0.5.3; each item below is its own task)
- **A envelope** exists; audit that no route builds the shape inline (an ESLint/test guard).
- **B pagination** `lib/api/pagination.ts`: offset (`page`/`limit`) and cursor helpers; hard caps; malformed params → 400 with
  field errors; tests for boundaries (0, negative, huge, non-numeric, repeated params).
- **C validation** `lib/api/validate.ts`: Zod wrapper for handlers; same schema fed to `zod-openapi`; error shape unified.
- **D rate limiter backend**: decide Redis client (`ioredis` + Lua, or `rate-limiter-flexible`) — **not** `@upstash/ratelimit`
  against plain Redis; keep the in-memory implementation as the dev/test default behind the same interface; per-IP,
  per-IP+email, per-account layers; atomic reserve-then-refund; failure mode when Redis is down (fail closed for auth routes).
- **E `withAuth` hardening**: `Sec-Fetch-Site` second signal; trust `x-forwarded-host` only behind the configured proxy;
  uploaded content on a separate cookieless domain (design now, build with LMS).
- **F auth-event audit**: sign-ins, failures, resets, role changes, session revocations (beyond the person-level events).
- **G breached-password check** (k-anonymity range query) at set/reset/change time, fail-open on network error.
- **H negative-test file** exercising every item (wrong tenant, no membership, revoked session, malformed pagination, limit
  exceeded) **as `app_user`** — the Phase 1 gate.

## 0.5.4 (new) — Users pages and invitations ⬜ (finishes 0.5.E)
Needs 0.5.2's roles. Tasks: (1) member list per school (paged, role/campus filters); (2) **invite** — hashed single-use link,
invitee proves the email and sets their own password; existing accounts attach only when the invitee accepts while signed in as
themselves (never silently by an admin); (3) change role / campus / deactivate (history survives; sessions revoked); (4) admin
email-change request; (5) tests incl. the cross-tenant takeover case; (6) audit; (7) AlEemaan port.

---

# Phase 1 — MVP: Core SIS + Finance (plan §1.1–§1.7)

**Rule for every table in this phase:** its RLS policy is in the *same migration* that creates it; a test (the catalog guard)
fails otherwise. Routes are `withAuth(…, { tenant: true, roles/permissions })`; data is read only through `auth.tenant.run`.
**Precondition: 0.5.2-F (RLS) and 0.5.3 done.**

| Sub-phase | Content | Depends on |
| :-- | :-- | :-- |
| 1.0 | `SchoolType` on `Tenant`; `SchoolSettings` auto-created with every tenant; permissions enum + `permissions` on membership (§1.7) | 0.5.2-F |
| 1.1 | Academic structure: `AcademicSession`/`Period`, `ClassGroup`/`Arm`, `Subject`, `AssessmentConfig`, `GradeScale` | 1.0 |
| 1.2 | People: `StaffRecord`, `StudentRecord`, `GuardianLink`, `StudentEnrollment` | 1.1 |
| 1.3 | Attendance | 1.2 |
| 1.4 | Results + approval workflow + publish + parent view | 1.1, 1.2, §1.7 permissions |
| 1.5 | Finance: `FeeStructure`, `Invoice`, `Payment`, gateway webhooks (+ mock Paystack engine) | 1.2 |
| 1.6 | Announcements, timetable | 1.1 |
| 1.7 | Settings UI with step-up MFA; audit trail | 1.0, 0.5.D |
| 1.8 | Phase gate: IDOR suite for every route + live end-to-end walk + sandbox payment incl. forged webhook | all |

For **each** of 1.1–1.6 the same steps apply:
1. **Design** the models and rules in the plan (what is tenant-scoped, what indexes, what is append-only).
2. **Migration**: tables + FKs + indexes + RLS policy + grants (+ `REVOKE` for append-only) in one file; catalog test passes.
3. **Policy tests as `app_user`** for the new tables (cross-tenant read/insert/move refused).
4. **Domain library** (`lib/<domain>/`): pure rules first (unit-tested), then DB functions (integration-tested, in tenant context).
5. **API routes in dependency order**, each: zod validation, `withAuth(tenant, roles/permissions)`, pagination, audit of
   changes, cross-tenant negative tests, rate limits where abusable.
6. **UI screens**: list → create/edit → detail; role-aware navigation; empty / loading / error states; phone layout; axe
   both themes; keyboard and focus behaviour.
7. **End-to-end journey test** for the sub-phase.
8. **Mutations**, docs, push; PR when asked.

### 1.0 detail
T1 `SchoolType` migration + default · T2 trigger/transaction creating `SchoolSettings` with each tenant (never nullable) ·
T3 `Permission` enum + `permissions[]`; `withAuth` accepts `permissions` (role **or** permission) · T4 tests incl. ADMIN implies all.

### 1.1 detail (academic structure)
T1 period kinds (term/semester/cohort by `SchoolType`) · T2 session CRUD with "one active session per campus" rule (conditional
update) · T3 class groups/arms · T4 subjects per class group · T5 assessment config with snapshot onto results · T6 grade scale as
data (band → letter → remark) with overlap/gap validation · T7 screens.

### 1.2 detail (people)
T1 staff record linked to `User` (invite flow from 0.5.4) · T2 student record with admission number generator (unique per
tenant, race-safe) · T3 guardian links (many-to-many, primary contact) · T4 enrollment as its own table (per-session history,
no `classGroupId` on the student) · T5 CSV import/export (validation report, dry-run first, size/row caps) · T6 screens.

### 1.3 detail (attendance)
T1 daily/period attendance record, unique per (student, date[, period]) · T2 bulk mark endpoint (idempotent upsert) ·
T3 cursor pagination (high churn) · T4 edit window and who may edit · T5 summary queries · T6 screens (fast grid on a phone).

### 1.4 detail (results)
T1 score entry per component with max-score validation against the snapshot · T2 status machine DRAFT → SUBMITTED → APPROVED →
PUBLISHED (conditional updates; `CAN_APPROVE_RESULTS`) · T3 position/ranking computed server-side with correct ties ·
T4 server-rendered report-card PDF · T5 parent/student view only of PUBLISHED, only own children (IDOR tests) · T6 promotion
(closes enrollment, opens next) · T7 screens.

### 1.5 detail (finance)
T1 fee structures per period/class · T2 invoice generation (idempotent per student+period) · T3 payment records, `Decimal`
Naira, kobo only inside the gateway client · T4 **mock Paystack** + dual-mode client (`PAYSTACK_NOT_CONFIGURED` in production,
never silently the mock) · T5 webhook: raw body first, HMAC-SHA512 with `timingSafeEqual`, always 200, own rate limit ·
T6 atomic `fulfillPayment` (`updateMany … status PENDING` as the lock; redirect-beats-webhook resolves to one fulfilment;
amount re-checked) · T7 status polling endpoint rate-limited per IP and reference · T8 receipts · T9 screens · T10 tests: re-stringified
body refused, 20 simultaneous fulfilments → one, amount mismatch throws.

### 1.6 detail
Announcements (audience targeting by role/campus, publish window) · timetable slots (clash detection per teacher/room/class).

### 1.7 detail (settings + step-up)
All toggles from plan §1.3 table; each change requires a fresh second factor (reuse 0.5.D) and is audited before/after
(`SettingsChangeAudit`); screen with confirmation and a change history.

### 1.8 gate
IDOR/cross-tenant suite over **every** route (file-system-discovered) · live walk: enroll → attendance → result → approve →
publish → parent views · sandbox payment + forged webhook fails · load sanity on the heavy list queries · security review
pass · docs, release notes.

---

# Phase 2 — Communication (plan, `comms.prisma`)
- **2.1 Templates & log**: `NotificationTemplate`, `NotificationLog`, NCC category rules (transactional / educational-admin /
  marketing; opt-out for marketing) — steps: schema+RLS · template editor · log viewer · tests.
- **2.2 Delivery**: BullMQ queue on Redis, providers (email via Resend, SMS/WhatsApp via Termii), retries with back-off, dead
  letters, per-tenant rate limits, provider webhooks for delivery status — steps: queue worker · provider clients behind an
  interface · idempotency keys · failure tests.
- **2.3 Staff↔parent messaging** with guardian-link authorization and abuse limits.
- **2.4 Triggers** wired from Phase 1 (fee reminder, result published, absence) with per-user preferences.
- **2.5 UI**: inbox, compose, preferences; gate: no message can reach someone outside the sender's tenant/links.

# Phase 3 — LMS (plan, `lms.prisma`)
- **3.1 Storage & scanning**: S3/MinIO object keys (never paths), upload via signed URL, size/type allow-list, **malware scan
  state machine** (`PENDING→CLEAN/INFECTED/SCAN_FAILED`), cookieless content domain + `nosniff`.
- **3.2 Assignments & submissions** (unique per student/assignment; late rules; score + feedback).
- **3.3 Learning materials** (publish windows, per class/subject).
- **3.4 Teacher/student/parent UI**; gate: an infected or unscanned file is never served; cross-tenant file access impossible.

# Phase 4 — Operations (design when a real customer need exists)
Leave requests (approval chain), payroll runs (only after tax/pension rules are scoped), library, transport/inventory as
needed. Steps per item: validate the need with a customer → design → same 8 steps as Phase 1.

# Phase 5 — Expansion (conditional on market signal)
Native mobile client on the same versioned REST API · higher-ed courses/credit units · vocational certificates · custom
domains (a new lookup key into the *same* verified-membership machinery). Nothing is designed until a paying customer or a
concrete request exists.

---

# Cross-cutting tracks (run alongside every phase)
- **Security:** each phase's mutation pass; dependency/advisory routine for Next.js and Prisma; secrets handling; backup and
  restore drill before any real data; privacy (data minimisation, retention, subject-access export).
- **Quality gates in CI:** `tsc`, ESLint, unit/integration/api/e2e (desktop + phone), https, axe both themes, the RLS catalog
  guard, the file-system-discovered route guard. A red gate blocks the PR.
- **Operations:** Solo installer (hardened compose, generated secrets, Caddy, no exposed DB port, roles created by the
  installer), SaaS deployment (pooler in transaction mode, Redis, per-tenant limits), observability (structured logs without
  secrets, error tracking), migrations as a deploy step run by the migrator role only.
- **Docs:** each sub-phase updates plan "as built", its phase record, the progress tracker, `CLAUDE.md` rules, `tests/README.md`.
- **Design artifact:** as-built artboards for the new screens published in one pass.
