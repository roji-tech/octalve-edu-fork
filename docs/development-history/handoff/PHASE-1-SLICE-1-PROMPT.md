# Phase 1, Slice 1 — implementation brief for Claude Code (local)

You are continuing a security-sensitive, multi-tenant school-management SaaS (**Octalve Edu**) that has been built phase by phase with a
strict engineering discipline. Another Claude session (the "reviewer") built Phases 0–0.5.4 and will **review your diff afterwards**, reading it
cold. Optimise for being *reviewable and provably correct*, not for speed. When something is ambiguous and security-relevant, **stop and write the
question down** (see "Hand-off") rather than guessing.

> **Read `TAKEOVER.md` (same folder) FIRST.** The maintainer has handed over *all* remaining work, in order: baseline → **finish 0.5.4 (mutation pass, docs, full run, push)** → lanes verification →
> **this slice** → the AlEemaan port. This brief is step 6 there; the "Base" below is superseded by it.

**Base:** branch `claude/app-shell-users` on the `fork` remote (`roji-tech/octalve-edu-fork`), **as you leave it at the end of `TAKEOVER.md` step 4** (0.5.4 finished, documented, pushed, one-lane suite green).
Record the SHA you started from in your hand-off. Your branch for this slice: `claude/phase-1-0-1-1`, created from that head.

## 0. Scope of this slice
**Phase 1.0 (foundations) and Phase 1.1 (academic structure)** from `docs/development-history/roadmap-breakdown.md` ("Phase 1") and
`domain-implementation-plan.md` §1.1–§1.7. Nothing else. Do **not** start 1.2 (people), attendance, results, finance, announcements, the Settings UI
or step-up MFA — they come in later slices, after review.

| Sub-phase | What |
| :-- | :-- |
| **1.0** | `SchoolType` enum on `Tenant` (K12 / HIGHER_ED / VOCATIONAL; additive, with a default so every existing tenant migrates). `SchoolSettings` — **one row per tenant, created with the tenant, never nullable** (every code path that creates a tenant: the setup wizard, `tests/support/db.ts#createTenant`, the data migration for existing tenants — idempotent). `Permission` enum + `TenantMembership.permissions Permission[] @default([])`; **`withAuth` accepts `permissions`** (role **or** permission; `ADMIN` implies every permission — plan §1.7); the four permissions are `CAN_APPROVE_RESULTS`, `CAN_MANAGE_FINANCE`, `CAN_PUBLISH_CONTENT`, `CAN_MANAGE_USERS`. Users page: let an ADMIN grant/revoke these (audited). |
| **1.1** | Academic structure, per plan §1.2: sessions and periods (term / semester / cohort by `SchoolType`), class groups and arms, subjects (per class group), assessment configuration (continuous-assessment components + max scores; it will later be **snapshotted onto each result**), grade scale **as data** (band → letter → remark, overlap/gap validation). Rules: **one active session per campus** enforced by a conditional update (and a partial unique index as the guarantee under concurrency); nothing referenced later by results may be deleted — **archive, never delete**. Screens: an "Academic setup" area per school (admin), list → create/edit → detail, copy-forward from last session. |

Starting design = plan §1.2 (`sis.prisma`), but it **predates** RLS, the shell, invitations and the lessons below. Reconcile it with the roadmap's 1.1 detail and
write a **"Build design — 1.0 / 1.1"** section into the plan **before any code** (the previous phases did exactly this; see "Build design — the shell" and "…Users and
invitations" in the plan for the shape: numbered decisions, a tests paragraph, a mutations list).

## 1. Ground rules (non-negotiable — they exist because of real findings)
1. **Read first, in full:** `CLAUDE.md`, `docs/development-history/domain-implementation-plan.md` (§0.5.2 incl. "Build design", §0.5.3, the shell + Users sections,
   §1.1–§1.7), `roadmap-breakdown.md`, `phases/phase-0.5.2-tenant-boundary.md`, `phases/phase-0.5.2H-app-shell.md`, `tests/README.md`. They are the source of truth;
   if code and docs disagree, stop and say so.
2. **Tenant boundary.** Every school route is `withAuth(handler, { tenant: true, roles | permissions })`; data is reached **only** through `auth.tenant.run(tx => …)`.
   ESLint forbids the raw `prisma` client and `trustedTenantId` in `src/app/(app)/schools/**` and `src/app/api/v1/schools/**`, and forbids `tx.user` there — read
   people **through** `tenantMembership`. The URL's `[code]` is a lookup key, never a claim. Queries inside the context **still name the tenant** (`where: { tenantId }`).
3. **Row-level security in the SAME migration that creates a table.** Every table with a `tenantId` gets `ENABLE` **and** `FORCE ROW LEVEL SECURITY` and a policy with
   **both `USING` and `WITH CHECK`** on `"tenantId" = app_tenant_id()`. Add each table to the expected list in the catalog guard (`tests/integration/rls.spec.ts`,
   "every table with a tenantId column…"). A table that must be append-only: no UPDATE/DELETE policy **and** `REVOKE` (re-run `app_grant_runtime_privileges()`).
   Migrations are **additive and immutable**: never edit one that exists; new files only; live-data-safe (the AlEemaan school's data must survive the same shape later).
4. **The app connects as `app_user`** (`DATABASE_URL`), never the table owner; `DIRECT_URL` is for migrations. Tests arrange data through the admin `db` helper and read through the runtime role.
5. **Tests are not allowed to be weaker than the code.** Never skip, disable, loosen or "fix" a test to make it pass; never add retries. A failing test is a finding: root-cause it.
6. **No PRs, no merging.** Commit small and often with meaningful messages; push to the `fork` remote on your branch (`git push -u fork <branch>`); the maintainer merges.
7. **Docs in the same pass as code**, always (plan "As built", a phase record, CLAUDE.md rules, `tests/README.md`, the trackers). Detailed — future sessions re-read them cold.
8. **Security defaults:** hash-at-rest for any token; no secrets or PII in audit rows or logs; one generic answer where existence would leak (unknown vs foreign id → the same 404/403);
   strict zod bodies for writes (unknown keys refused, not ignored); rate-limit anything abusable; CSRF is already enforced by `withAuth`; every state change is audited **in the same
   transaction** as the change; role/permission checks are decided on the server from the membership on every request (never from the client, a cookie or the shell).

## 2. Environment (your machine)
Node 22, pnpm 10.28 (`corepack enable`), Docker, `redis-server` on PATH (or `docker compose up -d redis` and set `TEST_REDIS_URL=redis://localhost:6380`), `openssl`.
```
git fetch fork && git checkout -b claude/phase-1-0-1-1 fork/claude/app-shell-users   # BASE: see "Base" below
cp .env.example .env                       # DATABASE_URL = app_user, DIRECT_URL = the owner (octalve) — both already correct for docker compose
docker compose up -d db                    # Postgres 16 on 5433; docker/postgres/init creates the unprivileged app_user role
pnpm install && pnpm exec prisma migrate deploy && pnpm db:roles
pnpm exec playwright install chromium
pnpm typecheck && pnpm lint && pnpm test    # the whole suite must be GREEN before you change anything — record the counts
```
`pnpm test` (builds, then every project, one lane) is the reference. `pnpm test:lanes` (optional, faster on a multi-core box, see `tests/README.md` "Lanes") is for the
inner loop only; **the one-lane run is what counts** at the end of a sub-phase. During development run only what you touched:
`pnpm exec playwright test --project=integration tests/integration/foo.spec.ts` (integration/api/e2e need a fresh `pnpm build` after source changes; unit and integration do not).
The test database is `<name>_test`; never point tests at a development database.

## 3. Process for EACH sub-phase (1.0, then 1.1), in this order
1. **Design in the plan** ("Build design — …"): decisions numbered and justified (what is tenant-scoped, indexes, uniqueness, deletion/archival rules, which role/permission
   may do what, what is audited), the test plan, the mutation list. Commit it alone.
2. **Migration** (+ Prisma schema) — tables, FKs, indexes, RLS, grants in one file. Generate with `prisma migrate diff … --script` and append the RLS statements by hand
   (see `prisma/migrations/20261009090000_users_invitations/migration.sql` for the exact shape, including a partial unique index and a read path).
3. **Policy tests as `app_user`** for each new table in `tests/integration/rls.spec.ts` — copy the shape of the existing blocks: no context = no rows; A never sees B; `WITH CHECK`
   on insert **and move**; **test write checks with statements that return nothing and read nothing** (`createMany`, `updateMany`, and a raw `UPDATE … SET "tenantId" = …` with no
   `WHERE` — `create`/`update` use `RETURNING`, which also runs the *read* policy and masks a broken `WITH CHECK`; found by mutation, S3/S8/S16).
4. **Domain library** `src/lib/<domain>/`: **pure rules first** (unit tests), then DB functions that take the tenant context (integration tests, as `app_user`). Authority/uniqueness rules
   that must hold under concurrency use conditional updates / row locks / a DB constraint — and get a **two-simultaneous-requests test** (see `members.spec.ts`, `invitations.spec.ts`).
5. **API routes** (dependency order), each: zod validation (`validate()`), `withAuth(tenant, roles/permissions)`, pagination from `lib/api/pagination.ts` where lists can grow, audit in the
   same transaction, rate limit where abusable, **cross-tenant negative tests** — the file-system-discovered route guard in `tests/api/tenant-boundary.spec.ts` already hits every new
   route cross-tenant, signed out, with no school and as a deactivated member; add the role/permission matrix and validation tests per route.
6. **UI** inside the shell (`src/app/(app)/…`, add navigation through `navFor` in `src/components/shell/nav.ts`; entries for unbuilt pages stay visible "Soon" text, never dead links):
   list → create/edit → detail, empty/loading/error states, native `<dialog>` via `components/ui/Dialog` for forms, `SelectField`/`TextField` primitives, one polite live region for results,
   focus never stranded (see `UsersPanel.tsx`: await the refresh, then place focus — no timers), phone layout (cards below `md`), tap targets ≥ 44 px.
7. **E2E** (desktop **and** phone) and **axe in both themes for every new screen and every open dialog/state** (`tests/e2e/responsive-and-a11y.spec.ts`, `checkScreen`).
   Every browser test is also a CSP test (the fixture fails on any violation).
8. **Mutation pass** (≥ 25 injected bugs per sub-phase): remove a role check, drop a `WITH CHECK`, trust a body-supplied tenant/id, skip the audit row, weaken a uniqueness rule,
   delete instead of archive, ignore a campus scope … — run the *unmutated* tests first, inject ONE bug, expect RED, restore. **Every survivor is a missing or weak test** (or an
   equivalent mutant, which you must justify): strengthen and re-run. Record the list and results in the phase record. (How the previous passes were run: see the "Mutation testing"
   sections in `phases/phase-0.5.2-tenant-boundary.md` and `phase-0.5.2H-app-shell.md`.)
9. **Full one-lane `pnpm test` green**, `pnpm typecheck`, `pnpm lint`, `pnpm build` clean. Then docs, then push. Then the next sub-phase.

## 4. Specific requirements
**1.0**
- `Tenant.schoolType` migration: additive with a default; document the default and how the setup wizard / future signup sets it. `SchoolSettings`: every tenant has exactly one row from
  creation (transaction at creation + a migration that backfills existing tenants, idempotent); a test fails if any tenant creation path leaves a tenant without one. Defaults per plan §1.3 table.
  No UI for editing settings yet (Phase 1.7) — but the row and an internal read helper exist.
- Permissions: `withAuth` options become `{ tenant: true, roles?, permissions? }` — a person passes if their **role is listed OR they hold a listed permission OR they are ADMIN**
  (ADMIN implies all). Update the compile-time tests in `tests/unit/with-auth.types.ts` and the runtime ones; a role-less, permission-less member is refused with the same one 403 body.
  `permissions` come from the **membership in that school** (never any membership), are read on every request, and a deactivated member has none. Users page: an ADMIN can grant/revoke
  the four permissions on a member (audit `MEMBER_PERMISSIONS_CHANGED` with before/after; the same authority rules as role changes — not yourself, never leaving a school without an
  administrator is unaffected because permissions are not roles). Note the explicit **non-goals** in plan §1.7 (no custom roles, no per-record ACLs, no hierarchy).
**1.1**
- One active session **per campus** (not per school): partial unique index + conditional update; activating a session deactivates nothing silently — it is refused with a clear
  message until the current one is closed, or implement an explicit "close and open" transaction (decide in the design, justify). Overlapping periods inside a session are refused.
- Grade scale: bands must cover 0–100 with **no gap and no overlap**, validated in a pure function (unit-tested with boundary cases: 0, 100, adjacent, inverted, decimals) and again by the API;
  editing a scale that results will later reference must not rewrite history — design versioning/snapshot now (plan: the snapshot is taken onto each Result later; make that possible).
- Assessment config: components with max scores summing to the exam total rule in the plan; snapshot-ready shape.
- **Archive, never delete** anything a later phase will reference; list endpoints take `status=active|archived|all`.
- Per-campus scope: a non-admin sees only their campus's structure where the model is campus-scoped; an ADMIN sees all; test both, including the cross-campus case.
- Copy-forward from the previous session: one transaction, idempotent (running it twice does not duplicate), audited, with a dry-run summary.

## 5. Lessons already paid for (do not re-learn them)
- Prisma `create`/`update` use `RETURNING`; the *read* policy then also applies — test `WITH CHECK` with `createMany`/`updateMany`/raw no-`WHERE` updates (above).
- `getByText` in Playwright also matches elements in closed `<dialog>`s and hidden duplicates (sidebar vs tab bar) — scope to `main`/`header`/a named group.
- To test an outside-click handler click genuinely inert space (a focusable ancestor's blur path masks it); to test Escape focus-return, Tab *into* the panel first.
- Never assert on a total that other tests' late mail/audit rows can change; assert on the specific recipient/row. Anything sent after the response (`after()`) arrives late under load.
- `React` `autoFocus` does not fire in a dialog opened later — `components/ui/Dialog` focuses `[data-initial-focus]` or the first field.
- Prisma `contains` does not escape `%`/`_` — escape LIKE wildcards in any user-supplied search.
- `$queryRaw` cannot deserialise `void` (e.g. `pg_advisory_xact_lock`) — use `$executeRaw`.
- A deactivated membership is "no membership" in **every** reader (`resolveTenant`, `getUserMemberships`, the sign-in admin check, audit fan-out): any new reader of `tenantMembership` must filter `deactivatedAt: null`.
- Solo-mode servers fail closed (500) when a second tenant exists: multi-school tests use the **SaaS-mode server** (`SAAS_URL`) and clean up with `removeCreatedTenants()`.
- Per-administrator/per-address rate limits are real: a test file that sends many requests as one admin must rotate admins (see `tests/api/invitations.spec.ts`).
- Static analysis: a layout is never the guard — every page calls `requirePageSession()`/`requireTenantPage(code)` itself.

## 6. Definition of done (per sub-phase) — all must be true and *evidenced in the hand-off*
- [ ] Design section in the plan, written before code; deviations explained.
- [ ] Migration applies on a fresh DB and on the current schema (`prisma migrate deploy`); catalog guard lists the new tables; `pnpm db:roles` still works.
- [ ] RLS tests for every new table (incl. write-check-alone tests); route guard covers every new route; role/permission matrix tests per route.
- [ ] Unit (pure rules), integration (as `app_user`), API (SaaS server), e2e desktop + phone, axe both themes for every state.
- [ ] ≥ 25 mutations, all caught or justified-equivalent, survivors turned into tests.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build`, one-lane `pnpm test`: **0 failures, 0 new skips**, counts recorded.
- [ ] Docs updated (plan as-built, phase record, CLAUDE.md rules, tests/README, trackers); pushed.

## 7. Hand-off (write this before you stop — the reviewer starts from it)
Create `docs/development-history/handoff/phase-1-slice-1.md` containing: (1) commit list with one line each; (2) what was built per sub-phase, mapped to the design decisions;
(3) **deviations from the plan/brief and why**; (4) **security-sensitive spots you want a second pair of eyes on** (file:line + why); (5) test evidence — the one-lane run summary per project,
new test counts, and the mutation table (id, bug, caught-by, survivors and what you did); (6) known gaps, TODOs, risks, anything you were unsure about; (7) **open questions** for the
maintainer; (8) how to run/verify the slice in five minutes; (9) the exact base and head SHAs. Be honest about what is *not* done or *not* verified.

## 8. What NOT to do
No PRs or merges. No `--no-verify`, no force-push, no history rewrites. No skipped/disabled tests, retries, or loosened assertions. No editing an existing migration. No raw `prisma` client or
`tx.user` in school routes/pages. No unscoped queries relying on RLS alone. No secrets in the repo. No scope creep into 1.2+. No "temporary" auth shortcuts. If the suite is red when you start,
stop and report — do not build on red.

## 9. Slices that follow (for context only)
Slice 2: 1.2 people (staff/student records, guardian links, enrollment, admission numbers, CSV import/export). Slice 3: 1.3 attendance + 1.6 timetable/announcements. Slice 4: 1.4 results workflow +
report cards + parent view. Slice 5: 1.5 finance (mock Paystack, webhooks, atomic fulfilment). Slice 6: 1.7 Settings UI with step-up MFA + the 1.8 gate. Each slice ends with a review round.
