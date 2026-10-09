@AGENTS.md

# Octalve Edu — orientation for whoever (or whatever) picks this up next

This file exists so a fresh AI session with access to this repo (and its sibling, AlEemaan) can get
productive in minutes, not hours. Read this whole file before touching code. It tells you what to
read next, in what order, which files are living documents you must keep current, and which are
stable references you can trust without re-verifying. `@AGENTS.md` above is Next.js's own
auto-generated framework-version notice — unrelated to this file, don't edit it, `next dev` rewrites
it.

## What this project actually is

Octalve Edu is a school-management platform meant to serve many different schools — **multi-tenant**
by design, with two deployment modes: **Solo** (one school, self-hosted, `DEPLOYMENT_MODE=solo`) and
**SaaS** (many schools' data in one shared database, isolated via Postgres Row-Level Security keyed
on a verified tenant ID). Both modes share the exact same schema and code paths — Solo just
short-circuits the tenant-picker UI, it does not skip the isolation machinery. Do not add anything
here that assumes there's only ever one school; that's the sibling project's job.

The canonical requirements document is `docs/PRD.md` (14 sections, synced from a Claude Doc) —
**read this before making any product-scope decision.** It includes a Security & Compliance Audit
tab cross-checked against a second independently-produced audit; findings from that audit are cited
inline throughout `domain-implementation-plan.md` as `(Audit #N)` — when you see that citation, the
decision it's attached to is not optional/aesthetic, it's closing a specific, numbered security
finding.

## The sibling project: AlEemaan — read this section, it matters

`/home/rojitech/Desktop/CODEC/NextJS/AlEemaan` is a separate but deliberately parallel project: same
stack (Next.js 16, TypeScript, Prisma 6.19.3/Postgres, hand-rolled auth against database sessions),
same architect, built alongside this one — but **single-tenant** (exactly one real school, no RLS,
no `Tenant`/`Campus` concept — `Branch` instead) where this project is multi-tenant. The two share
design decisions on purpose. As of 2026-09-30:

- **This project's auth plan (`domain-implementation-plan.md` §0.5.1–0.5.3) is canonical for both
  projects.** AlEemaan's own auth was fully rebuilt against it and is further ahead in one sense
  (actually built and verified live) while this project is further ahead in another (the design
  itself went through a deeper two-AI security review and has more hardening specified — session
  token hashing, RLS role setup, MFA pending-state flow, layered rate limiting — see
  `docs/auth-review-2026-09-29.md` for the full record). **When this project's §0.5.1 actually gets
  built, cross-check AlEemaan's `src/lib/auth/{session,password,rate-limit}.ts` first** — it's the
  working, verified reference implementation of the shared mechanism (hand-rolled login/logout
  against hashed database-session tokens); adapt it for `TenantMembership`/`Campus`, don't
  reinvent it.
- A security finding in one project's auth almost certainly applies to the other's.
- **Before starting any auth or schema work here, check whether AlEemaan's own
  `docs/development-history/domain-implementation-plan.md` has moved ahead of this one** (or vice
  versa) on a shared topic.

Two more repos show up in comments/history but are **not siblings to keep in sync with** — they're
one-off pattern sources, referenced once for a specific technique and then done:
- `/home/rojitech/Desktop/CODEC/NextJS/proplity` — source of the first-run setup-wizard pattern and
  the atomic-conditional-update bootstrap race-guard (§0.5.0, already built here). Also has its own
  real auth implementation, reviewed in detail 2026-09-30
  (`proplity/docs/auth-review-2026-09-30.md`) — worth reading for what a JWT+refresh-token
  architecture gets right (timing-safe compare, reuse-detection/rotation) and wrong (a real
  logout-doesn't-revoke bug), but **do not port its JWT+refresh model here** — database sessions were
  a deliberate, audit-driven choice (Audit #23), not an oversight.
- `/home/rojitech/Desktop/CODEC/OCTALVE/ims` — source of the multi-file Prisma schema convention
  (`prisma/schema/*.prisma` instead of one `schema.prisma`, already adopted here) and the `forTenant()`
  Prisma-extension pattern this project's §0.5.2 is built from.
- `/home/rojitech/Desktop/CODEC/NextJS/TheNiche` — source of the mobile bottom-tab-bar dashboard
  pattern used in AlEemaan's design artifact; not yet relevant to this project's own frontend.

## Read in this order, first session

1. **This file.**
2. **`/home/rojitech/Desktop/CODEC/out/tasks.md`** — the maintainer's single task tracker for both repos (outside the repos, so it is not in git). **Check that it exists and read it at the start of every session**: it says what is done, in progress, blocked, and what the maintainer has decided. If the file does not exist, **create it first** (a legend `[x] done · [~] in progress · [ ] to do · [!] blocked / needs the maintainer`, the rules in force, then one section per repo) and fill it from the progress tracker, rather than working without one. Then continue from it.
3. **`docs/development-history/octalve_edu_progress.md`** — the single source of truth for "what's
   actually built right now," checked against the real repo. Has a "What's real vs. what's
   designed-but-unbuilt" section specifically to prevent treating a written-down decision as done —
   read that section literally, it's not decoration.
4. **`docs/development-history/domain-implementation-plan.md`** — the step-by-step build plan, ~2300
   lines. Long, but organized by phase — find the current phase (check the progress tracker's "Next
   action" first) and read that section, don't read linearly front to back unless you're new to the
   whole plan.
5. **`docs/PRD.md`** — requirements + architecture decisions with reasoning. Read the sections
   relevant to what you're building; §7 (tenant trust boundary, API conventions) is referenced
   constantly elsewhere and worth reading in full early.
6. **`prisma/schema/*.prisma`** — the actual current data model. This is ground truth; if a doc and
   the schema disagree, the schema is right and the doc is stale (fix the doc).
7. **`docs/development-history/phases/*.md`** — one completion record per finished phase.
8. **`docs/auth-review-2026-09-29.md`** — before touching anything auth-related. Contains the
   adjudicated findings from a two-AI security cross-review; several plan sections cite it directly.
   Then **`docs/auth-review-2026-09-30-verification.md`** — what happened when the design was built and
   executed: the status of each finding (P0 #4, the `__Host-` cookie, is closed — verified in real
   Chromium over TLS) and the six new classes of defect the running suite found.

## Files that change constantly — update these every session that changes anything real

- **`/home/rojitech/Desktop/CODEC/out/tasks.md`** — the single task tracker for Octalve Edu *and* AlEemaan. Update it as work moves, not at the end: mark `[~]` when you start a task, `[x]` when it is done *and verified*, `[!]` when you are blocked on the maintainer; add every new task, open question and deferred item the moment it appears; record real numbers (tests passed/failed/not run), branch names and PR links. Never mark something done that was not run. Before a context compaction or hand-off, make sure it holds everything the next session needs.
- **`docs/development-history/octalve_edu_progress.md`** — update its "Last Updated" date, the
  Overall Status Summary, and "Next action" after *any* real change. This is the first file any
  future session reads.
- **`docs/development-history/domain-implementation-plan.md`** — add to it *before* writing code for
  a new phase; correct it in place with an explicit note when implementation reveals the design was
  wrong (the §0.5.1 heads-up about Auth.js's Credentials+database-session incompatibility, later
  fully rewritten in the second hardening pass, is the pattern to follow — don't silently edit past
  decisions without saying what changed and why).
- **`prisma/schema/*.prisma`** — grows one file per domain area as phases are built (`sis.prisma`,
  `finance.prisma`, `comms.prisma`, `lms.prisma` are already named in Phase 1 onward's sketches).

## Files that are stable reference — read once, trust, don't expect them to move

- `docs/adr/` — short ADRs (one per decision someone might reverse by mistake); read the index before changing RLS, locks, permissions, deactivation or migrations. Rules are in its README: never edit an accepted decision, supersede it.
- `docs/PRD.md` — changes only when the canonical Claude Doc is re-synced; treat as authoritative
  between syncs.
- `docs/branches-and-environments.md` — the `dev`/`main`/`prod` git convention. Note it documents the
  *intended* convention honestly alongside what actually exists yet — check its own text for which
  parts are aspirational.
- `docs/development-history/phases/*.md` — append-only history, never edited after being written.
- `docs/auth-review-2026-09-29.md` — a dated snapshot of a specific review; if you do further auth
  work and find new issues, add a new dated file rather than editing this one, same convention as the
  phase docs.

## Working rules in this repo (follow these without being asked)

**Task tracking (applies to every session, in both repos).** All tasks are organized inside `/home/rojitech/Desktop/CODEC/out/tasks/` (and mirrored in repo `out/tasks/`):
- `current-tasks.md` contains the active sequential register and execution queue.
- Every individual task file is named with a 4-digit sequential prefix: `NNNN-<kebab-name>.md` (e.g. `0001-phase-1-2-people-and-enrolment.md`), based on `template.md`.
- How to tick: change `[ ]` to `[x]`. The table shows the characters, not a clickable box.
- Always record start and end date and time in UTC (`YYYY-MM-DD HH:MM:SS UTC`).
- Update tasks as work starts, finishes, blocks or appears — it is the maintainer's view of progress, separate from in-repo progress trackers.

1. **Design before code.** Extend the relevant phase section in `domain-implementation-plan.md`
   first. This phase (0.5) exists specifically because the security audit found two *architectural*
   Critical findings (tenant-trust boundary, session revocability) that nothing in Phase 1 onward is
   safe to build on top of until closed — this isn't a generic best-practice, it's the literal reason
   this phase is sequenced first and separately from feature work.
2. **Verify live, not just "it compiles."** Phase 0 and 0.5.0 were both verified against a real local
   Postgres (`docker compose up -d`, port 5433) with actual requests, not just a clean build. Truncate
   test data afterward so the dev DB starts clean for the next session.
3. **The RLS verification bar is explicit and higher than usual**: "the code compiles" is *not*
   sufficient evidence Phase 0.5.2/0.5.3 are done — a negative-test suite (wrong tenant in the URL, no
   membership, session revoked mid-request) must actually fail closed, run as the **`app_user`** role,
   not the migration-owner role (RLS policies are silently inert against an owner/BYPASSRLS
   connection — a test that runs as the owner can pass while protecting nothing).
4. **Always update docs in the same pass as the code change.**
5. **Cite reasoning, not just conclusions** — `(PRD §N)` / `(Audit #N)` citations throughout the plan
   doc exist so a decision never has to be re-derived or re-justified from scratch.
6. **Multi-file Prisma schema** (`prisma/schema/*.prisma`, `prisma.config.ts` points the CLI at the
   folder) — add new files per domain area, don't grow one file indefinitely.
7. **Tests ship with the change, and a security test must be seen to fail.** Every security-relevant
   assertion in `tests/` was mutation-checked: inject the bug it claims to catch, confirm the suite goes
   red, restore. Do the same for any new one — a test that has never failed has not been shown to test
   anything. Drive UI changes in a real browser and read the screenshots; the verification pass for 0.5.1
   found ten defects (lost keyboard focus, a password leaking into the URL on a no-JS submit, bcrypt's
   silent 72-byte truncation, low contrast, …) that reading the code had not.
8. **UI is tokens, not colours.** Components name semantic tokens (`bg-surface`, `text-fg-muted`,
   `border-line`, `bg-brand-strong`, `text-brand-fg`, …) and never palette classes (`slate-400`,
   `indigo-600`). Exactly two files are brand-specific — `src/app/brand.css` (colours) and
   `src/lib/brand.ts` (words) — and everything in `src/components/ui` and `src/components/auth` stays
   **code-identical with AlEemaan's** (`drift.py`-style normalised comparison; a difference needs a
   reason in the plan doc). Light/dark is a `theme` cookie read on the server (`<html data-theme>`), not
   an inline script — the nonce-based CSP (plan §0.5.B) depends on there being none. New UI must pass
   axe in **both** themes, be ≥ 44 px on phones, and be added to `responsive-and-a11y.spec.ts`. Design
   and numbers: plan §0.5.A; work log: `docs/development-history/phases/phase-0.5.A-design-language.md`.
   **Porting to/from AlEemaan: product-specific constants are not shared** — the cookie names in
   `session.ts`, the brand files, the membership model's name. Copying a "shared" file wholesale once
   carried this repo's cookie name into AlEemaan (58 tests failed at once — on its live school it would have
   signed everyone out), and the normalised drift comparison had hidden it. After a port, read the *raw* diff.

## Current state, as of 2026-10-06 (verify against `octalve_edu_progress.md` — it may have moved since)

- Phase 0 (scaffold) and Phase 0.5.0 (setup wizard, Solo-only) are done and verified live.
- **Phase 0.5.1 (auth) is BUILT, VERIFIED AND MERGED** — it started on branch `claude/auth-0.5.1-port` of the
  maintainer's fork `roji-tech/octalve-edu-fork` (the Claude GitHub App isn't installed on `octalve-core`, so work
  reaches `master` by the maintainer's PR; the maintainer merges, and both masters are kept identical). The design went through a full two-AI security review
  (`docs/auth-review-2026-09-29.md`) and a second hardening pass, and was built by porting
  **AlEemaan's already-verified implementation** (a spike into adopting Better Auth instead was run and
  rejected — see "Known open items," resolved, below), with the deliberate divergences recorded in the
  plan doc's §0.5.1 "Build design for the port". **Read `docs/development-history/phases/phase-0.5.1-auth.md`
  first** — it is the work log, the list of defects the verification found, and the mutation-testing
  record. Shared file/function names with AlEemaan are intentional (table in the plan doc); keep them in
  sync.
- **There is a real test suite: `pnpm test`** (build + Playwright: unit, integration, API, browser at
  desktop and phone sizes, axe accessibility, and a real-HTTPS cookie run). Read `tests/README.md`
  before changing anything under `src/lib/auth`, `src/app/api/v1/auth`, `/login`, `/dashboard` or
  `/setup`, and run it before opening a PR. It needs a Postgres (`docker compose up -d db`), Chromium
  (`pnpm exec playwright install chromium`) and `openssl`.
- **Phase 0.5.A (shared UI design language) is BUILT AND VERIFIED, stacked on the auth branch**: branch
  `claude/design-tokens-theme` of the same fork (based on `claude/auth-0.5.1-port` — merge that first).
  Design-artifact colours and layout as semantic tokens with an Octalve-indigo brand, a server-rendered
  light/dark theme, the re-skinned shared components, and a *real* "Keep me signed in" (unchecked →
  session cookie + 12-hour server cap; ticked → the 30 d / 90 d policy, 7 d for admins). AlEemaan has the
  same, in its own green, plus the admin shell. Still to come in this series, each designed in the plan
  first: **0.5.B** nonce-based CSP, **0.5.C** password reset/change, **0.5.D** TOTP MFA.
- **Phase 0.5.3 (shared API infrastructure) is BUILT AND VERIFIED** — same branch. **Rules that follow:** (1) new routes use `ok`/`fail`, `parseOffsetPagination` /
  `parseCursorPagination` and `validate({ body, query }, …)` *inside* `withAuth` — a bad parameter is a **400 naming the field**, never clamped, never first-wins;
  unknown body keys are stripped, never passed on; (2) `X-Forwarded-Host` is **never** trusted unless `TRUST_FORWARDED_HOST=true` (set only behind a proxy that
  overwrites it); CSRF also refuses `Sec-Fetch-Site: cross-site|same-site`; (3) rate limits go through `reserveAttempt`/`refundAttempt`/`checkRateLimit` — the
  store (`memory` | `redis`) is a deployment choice; **more than one instance needs `RATE_LIMIT_STORE=redis`**; Redis down degrades to memory, never to "no limit";
  (4) never put an `await` inside the memory store's `reserve` (the atomicity argument); (5) a new password is checked with `checkNewPasswordOnServer` (shape, then
  breach, fail-open); (6) audit sign-in events carry a device *kind*, never an IP or a raw user agent. Test prerequisite: `redis-server` on `PATH`. Record:
  `docs/development-history/phases/phase-0.5.3-api-infrastructure.md`.
- **Phase 0.5.2 (tenant trust boundary — application layer AND row-level security) is BUILT AND VERIFIED** — branches `claude/tenant-trust-boundary` (app layer, 0.5.3)
  and `claude/tenant-rls` (the database half). **Rules that follow:** (1) the URL's `[code]` is a lookup key — every school route is
  `withAuth(…, { tenant: true })` and every school page `requireTenantPage(code)`; **never read a school's data from a code, an id in the
  URL or the body**; (2) data is reached only through `auth.tenant.run` / `forTenant(VerifiedTenantId)` — ESLint forbids the raw `prisma`
  client and `trustedTenantId` under `src/app/(app)/schools/**` and `src/app/api/v1/schools/**`; (3) **queries inside the tenant context still
  name the tenant** (`where: { tenantId }`): RLS is the net under the code, not a reason to write unscoped queries; (4) "no such school",
  "malformed", "not a member" and "role not allowed" are **one 403 body**; (5) `roles` is checked against the role **in that school**,
  never any membership; (6) `DEPLOYMENT_MODE=solo` asserts exactly one tenant and fails closed (500); multi-school tests use the **SaaS-mode
  server** and clean up their schools; (7) new tenant routes need no new test to be guarded — the file-system-discovered route test hits them
  cross-tenant. **RLS rules:** (8) the app connects as **`app_user`** (`DATABASE_URL`), never the table owner — `DIRECT_URL` is the migrator and is for `prisma migrate` only; create the
  role with the docker init script or **`pnpm db:roles`**; (9) **every table with a `tenantId` ships, in the SAME migration that creates it,
  `ENABLE` + `FORCE ROW LEVEL SECURITY` and a policy with BOTH `USING` and `WITH CHECK` on `"tenantId" = app_tenant_id()`** — the catalog guard in `tests/integration/rls.spec.ts` fails the build otherwise
  (and you must add the table to its expected list); a table with **no** `tenantId` must be added to the reviewed identity-table list *on purpose*; a table that must be append-only gets no
  UPDATE/DELETE policy **and** a `REVOKE` (call `app_grant_runtime_privileges()` again); (10) the **test admin must bypass RLS** and fixtures go through `db`, never the runtime role — a negative test run as
  the owner passes vacuously; (11) a bypassing role in production is refused by `assertRlsEnforced()` (set `ALLOW_RLS_BYPASS=true` only knowingly) — **never memoise a failure**. Records:
  `docs/development-history/phases/phase-0.5.2-tenant-boundary.md`; map: `docs/development-history/roadmap-breakdown.md`. **Next:** Phase 1 (academic structure, designed first — see the plan).
- **The app shell (0.5.2-H) is BUILT AND VERIFIED** — branch `claude/app-shell-users` (stacked on `claude/tenant-rls`). **Rules that follow:** (1) every signed-in page lives in `src/app/(app)/` (no URL change) and renders
  inside `AppShell`; the layout only **displays** — **each page still guards itself** (`requirePageSession()` / `requireTenantPage(code)`, both `cache`d per request), because a layout is not re-rendered on client navigation;
  (2) the shell learns "which school is this path in" from the person's **own** memberships (`schoolFromPath`, `ShellProvider`) — display only; a path naming a school they are not in matches nothing; (3) navigation is
  **data** (`navFor(school)` in `components/shell/nav.ts`) — sidebar, tab bar and sheet derive from it; an entry whose page is not built has `href: null` and renders as visible "Soon" text, **never a link to nothing**;
  role-hiding is a courtesy, the page and API decide; (4) a new disclosure uses `useDisclosure`; (5) in tests, `getByText` also matches the closed phone `<dialog>` — scope to `main`/`header`/a named group, and test an
  outside-click handler by clicking **inert** space (a focusable ancestor's blur path masks it). Record: `docs/development-history/phases/phase-0.5.2H-app-shell.md`.
- **Phase 1.0 (foundations) is BUILT** — branch `claude/phase-1-0-1-1`; record `docs/development-history/phases/phase-1.0-foundations.md`; **full gate and mutation pass pending** (the maintainer deferred all mutation passes to the end of Phase 2). **Rules that follow:**
  (1) **every school has exactly one `SchoolSettings` row, made by the database** (trigger on `Tenant`) — never insert one from application code, and read it only through `getSchoolSettings(tx, id)`, which throws when it is missing (never a fallback default);
  (2) **permissions are checked with `withAuth({ tenant: true, permissions: [...] })`**, never by reading `auth.tenant.permissions` in a handler: the rule is `lib/auth/authorize.ts` (role OR permission; an ADMIN implies every permission **for the `permissions` option only** — never for `roles`);
  (3) permissions live on the **membership in that school** and are read on every request — a grant takes effect on the next request, a deactivated member holds none; (4) **only an ADMIN of the school may grant or revoke them, and that power is never delegable** (not even by `CAN_MANAGE_USERS`);
  (5) permissions exist only on `TEACHING_STAFF` / `NON_TEACHING_STAFF` — a CHECK constraint says so; a role change to anything else must clear them **in the same transaction**; (6) `Tenant.schoolType` defaults to K12 and decides the kind of academic period — read it, don't assume K12;
  (7) a new tenant-scoped table is added to the catalog guard's expected list in `tests/integration/rls.spec.ts` (that friction is on purpose). Gate for every change: `pnpm typecheck` → `pnpm lint` → `pnpm format:check` → `pnpm build` → tests.
- **Phase 1.1 (academic structure) is BUILT** — branch `claude/phase-1-0-1-1`; record `docs/development-history/phases/phase-1.1-academic-structure.md`; **mutation pass pending** (end of Phase 2). **Rules that follow:**
  (1) **a refusal that can follow a write must roll back** — never `return refuse(...)` after the first write in a `tenant.run` (it commits); check before writing, or use `refuseAndRollBack` inside `rollingBack(...)` (`lib/academics/sessions.ts`);
  (2) every academic row names its school and points at its parents by **composite FK `(tenantId, parentId)`**; create parents then `createMany` children (Prisma cannot nest a composite tenant key); (3) **one writer per scope**: take the scope's `pg_advisory_xact_lock` before any check-then-write, and let a **conditional `updateMany` row count** decide transitions;
  (4) **nothing academic is deleted** — archive (partial unique indexes over non-archived rows let a name be reused); the only deletes are `SubjectOffering`, an unlocked scheme's components and a scale's bands; (5) a **locked** scheme/scale (a result references it — Phase 1.4 calls `lockScheme`/`lockScale`) is immutable **in the database**; a change is `new-version`, which archives the predecessor and links `supersedesId`;
  (6) marks and score bands are compared as **integers of hundredths** (`toHundredths`) — never floats; a grade is `gradeFor(bands, score)` only; the period kind comes from `Tenant.schoolType`, never from the client; (7) reads are ADMIN + staff (staff see school-wide rows and their own campus's), writes ADMIN only; an unknown, foreign or other-campus id is the **same 404**;
  (8) the "Academic setup" dialogs stay mounted after closing (`useDialog`) so focus returns to the opener; remount on the next open. API and browser tests run the **production build** — `pnpm build` after changing a route or screen. Gate: `pnpm typecheck` → `pnpm lint` → `pnpm format:check` → `pnpm build` → tests.
- **Closing a session takes time (added to the Phase 1.1 branch 2026-10-07; ADR 0008).** Rules: (1) `close` only **schedules** (`closeAt` = now + 24 h, or + 1 min with the administrator's own password); until then the session is fully `ACTIVE`; (2) **always read a session's status through `effectiveStatus`** (or `SessionView.status`, which uses it) — never trust `row.status === "ACTIVE"` for a session that may be past its `closeAt`; every session read/write goes through `findVisible`, which first runs `settleDueClosings`; (3) the password proof is `proveOwnPassword` (`lib/auth/reauth.ts`, 5 failures per account, success refunded, never logged) — use it for any new "are you sure it is you" action; (4) a closed session reopens only with a typed reason and only if nothing else in its scope is active; the reopen path uses the rollback helpers (rule 1 of Phase 1.1); (5) `activate … closeCurrent` needs the password. Mutation pass pending.
- **Phase 1.2 (people and enrolment) is BUILT** — branch `claude/phase-1-2-people` (stacked on `claude/phase-1-0-1-1`); record `docs/development-history/phases/phase-1.2-people.md`; **mutation pass pending** (end of Phase 2). **Rules that follow:**
  (1) people are **read** by administrators and staff (campus-scoped) and **written by administrators only**; students and parents get the same 403 as a stranger; unknown, foreign and other-campus ids answer one 404; (2) **enrolment is per session** (unique student+session); capacity is shown, never enforced; withdrawing needs a typed reason; (3) admission numbers are generated by `UPDATE … RETURNING` on `AdmissionCounter` **in the insert's transaction** (a failed insert burns none); (4) guardian links are created only by an administrator, `APPROVED`; **no parent-facing read may skip `status = 'APPROVED'`**; (5) a staff record's account must be a member of the same school (composite FK); linking is a conditional `WHERE userId IS NULL`; an invitation carrying `staffRecordId` links on acceptance **in the same transaction**;
  (6) CSV import is **all or nothing** in one transaction under the school's lock; a dry run is the same code followed by a rollback; the confirm step re-validates; names are looked up by name inside the school; export uses the import's columns, neutralises `= + - @ tab CR` cells, is capped, audited, administrators only; (7) **the audit log holds ids and field names for people, never a date of birth, phone or email value**; (8) `Tenant.schoolType` comes from the server setting `DEFAULT_SCHOOL_TYPE` — the browser never sends it and a school's administrator cannot change it; (9) **every `useDialog` dialog is keyed by its name plus `n`** (`key={`archiving-${archiving.n}`}`) — a bare `n` collides with the next dialog's and leaves the first open; (10) a route that needs more than the 1 MiB body takes `maxBodyBytes` in `validate()`, the default stays global; (11) the default Next 404 page violates the CSP — keep `src/app/(app)/not-found.tsx`.
- **Phase 0.5.4 (Users pages and invitations) is BUILT AND VERIFIED** — branch `claude/app-shell-users`. A school's administrator lists members, invites by email, changes
  role/campus, deactivates and reactivates; an invitee accepts at `/accept-invite`. **Rules that follow:** (1) an invitation token is 256-bit, travels in the URL **fragment**, and only
  its SHA-256 is stored; the page **never acts on arrival** (scanners open links) — the person clicks; (2) **single use is a conditional `updateMany` whose row count decides** (a read then a
  write lets two clicks both win); (3) the unauthenticated accept path reaches its one row through `forInvitation(hash)` (`app_invitation_hash()`, read-only RLS) — never widen it to a
  `tenantId` lookup by email; (4) an existing account is attached to a school **only by its owner** (signed in as themselves) — an administrator can never set someone else's password or
  attach an account for them; (5) the **last active ADMIN of a school can be neither deactivated nor demoted** (guarded with `SELECT … FOR UPDATE` on the school's admin rows), and nobody can
  change, deactivate or reactivate **themselves** (`SELF`) — only an ADMIN of that school may use any of these routes; (6) one live invitation per (school, address): inviting is serialised by an advisory
  lock on the pair and a partial unique index is the guarantee — re-inviting revokes the earlier open one (audited), and an address that is already a member (active or deactivated) is refused with
  its own reason; (7) search terms go through `escapeLike()`
  (a `%` or `_` is a character, not a wildcard); lists are paginated with the shared helpers; (8) deactivation revokes the person's sessions **in the same transaction** and keeps
  their history; (9) no audit row carries a token, a hash or a password — every write is audited in the same transaction as the change. Test notes: `tests/support/outbox.ts` **throws** on a corrupt outbox (it used to return "no mail") and
  the setup project empties it each run; a parallel mutation runner lives in `docs/development-history/handoff/tools/`. Record: `docs/development-history/phases/phase-0.5.4-users-invitations.md`.
- **Phase 0.5.E (account self-service) is BUILT AND VERIFIED** — branch `claude/account-self-service`, stacked on the
  dev-inbox branch. A signed-in person can edit their name, change their email (confirmed by a link to the **new**
  address) and see / end the places they are signed in. **Rules that follow:** (1) the change-email request gives the
  **same answer whatever the address is** (status, body, headers, timing) — the lookup, the token and every mail run in
  `after()`, and an address that already has an account gets a notice instead of a link; (2) confirming an email change is
  **one transaction** that sets the address *and* deletes every session, password-reset link, sign-in challenge and other
  change request of that person — if you add another credential-like table keyed by user, it goes in that transaction;
  (3) a page opened from an emailed link **must not act on arrival** (scanners open links) — the person clicks; (4) read a
  one-time token from the URL fragment with `useFragmentToken()` (it copes with a second link opened in the same tab) —
  don't re-implement it; (5) a session id that isn't the caller's answers **exactly like one that doesn't exist**, and no
  IP address is stored for sessions — don't add one without a design; (6) names go through `checkName()` (no control or
  bidi-override characters; ZWJ allowed); (7) the per-account request limit counts only *verified* requests — keep guess
  limits and volume limits separate. *Invite & activate* and deactivation wait for the Users pages. Record:
  `docs/development-history/phases/phase-0.5.E-account-self-service.md`.
- **Phase 0.5.F (dev email inbox) is BUILT AND VERIFIED** — branch `claude/dev-email-inbox`, stacked on the
  TOTP branch. A fourth email transport, `inbox`, keeps the last 50 messages in process memory and an in-app
  widget (bottom-right launcher, unread badge, text bodies, clickable links) shows them — so reset links and
  security notices are readable locally and on a staging deploy with no mail provider. **Rules that follow:**
  (1) **`devToolsAccess()` in `lib/dev-tools.ts` is the only decision** about whether any dev affordance exists
  (`off` | `open` | `{token}`) — never test `NODE_ENV` or `VERCEL_ENV` yourself, and never mount, route or run a dev
  tool without it; production is *never* on, a mistyped `APP_ENV` is production, staging needs `DEV_TOOLS=true`
  **and** `DEV_TOOLS_TOKEN`; (2) message bodies are rendered as **text**, never HTML; (3) `EMAIL_TRANSPORT=inbox`
  where the tools are off must fail loudly, and the log line never carries the body; (4) the inbox is per process —
  do not rely on it across serverless instances. Env: `APP_ENV`, `DEV_TOOLS`, `DEV_TOOLS_TOKEN`. The Paystack half
  of the maintainer's guide waits for Finance (plan §0.5.F says what must change in it first). Record:
  `docs/development-history/phases/phase-0.5.F-dev-email-inbox.md`.
- **Phase 0.5.D (TOTP two-step verification) is BUILT AND VERIFIED** — branch `claude/totp-mfa`, stacked on the
  password-reset branch. Password → (if the account has an *active* second factor) a short-lived, attempt-limited
  **challenge and no session** → `POST /api/v1/auth/login/mfa` with a code or a recovery code → session. TOTP is
  our own RFC 6238 (`lib/auth/mfa/`), secrets AES-256-GCM-encrypted under `MFA_ENCRYPTION_KEY` (required — no key,
  no MFA; **never add a development fallback key**), recovery codes keyed-hashed. **Rules that follow:** (1) a
  session from a sign-in is created in **`completeSignIn()` only**; (2) every "use it once" rule (a TOTP step, a
  recovery code, a challenge, a confirmation) is a **conditional UPDATE whose row count decides**, never a read
  then a write; (3) `lib/auth/mfa/codes.ts` is imported by client components — keep it free of `node:crypto`;
  (4) the enrolment secret lives in component state only, and the QR is drawn in the browser, never by an online
  service; (5) a password reset/change kills pending challenges but a reset **never** turns MFA off. Lost both
  factors: `pnpm mfa:reset -- <email>`. Record: `docs/development-history/phases/phase-0.5.D-totp-mfa.md`;
  next: 0.5.E (self-service built — see above; invite/deactivate wait for the Users pages), then the §0.5.2 work.
- **Phase 0.5.C (password reset and change) is BUILT AND VERIFIED** — branch `claude/password-reset`, stacked on
  the CSP branch. Forgot → emailed single-use link (token in the URL *fragment*, hashed at rest, 30 min) → reset
  deletes all the person's sessions; change-password re-verifies the current password and keeps only this
  session. One shared rule for new passwords: `checkNewPassword()`. Email via `lib/email` (`EMAIL_TRANSPORT`
  = resend | console | file; production needs `RESEND_API_KEY` + `EMAIL_FROM`). **Never make the forgot-password
  response depend on whether the account exists** (content or timing). Record:
  `docs/development-history/phases/phase-0.5.C-password-reset.md`; next: 0.5.D (TOTP — built, see above), then 0.5.E extras (plan).
- **Phase 0.5.B (nonce-based script CSP) is BUILT AND VERIFIED** — branch `claude/csp-nonce`, stacked on the
  0.5.A branch. `src/proxy.ts` mints a nonce per page request and sets the policy (`src/lib/security/csp.ts`);
  `CSP_REPORT_ONLY=true` is the live-deployment valve; the API has a static `default-src 'none'` policy. **Rules
  that follow:** no inline `<script>` and no `style=""`/`<style>` in our markup; every page stays dynamic; new
  third-party origins are a CSP change, not a convenience. The `csp` test fixture fails any browser test that
  triggers a violation. Record: `docs/development-history/phases/phase-0.5.B-csp.md`.
- Phase 1 onward (Core SIS + Finance, Communication, LMS, Operations, Expansion) have schema sketches
  in the plan doc but no migrations, no API routes, no UI — 0% built.

## Known open items (not forgotten, deliberately not yet done)

- ~~Evaluate Better Auth vs hand-rolling §0.5.1~~ **Resolved 2026-09-30**: hand-roll, mirroring
  AlEemaan. A research spike found Better Auth's session model fits well but its **hashed-token-at-rest
  requirement is not shipped** (only an unmerged draft PR, better-auth/better-auth#11444) — that's the
  one non-negotiable, audit-driven requirement AlEemaan's build already proves out standalone. Its
  `organization`/`teams` plugin also doesn't map as cleanly onto `Tenant`→`Campus` (optional anchor)
  as the schema already built here. Worth revisiting only if Better Auth's `storeTokenHash` option
  ships and stabilizes, or if TOTP MFA gets built (Better Auth's `twoFactor` plugin is worth using as
  a *reference implementation*, not a dependency to adopt wholesale).
- ~~`app_user` Postgres role~~ **Resolved 2026-10-05** — created by `docker/postgres/init/01-roles.sql` / `pnpm db:roles`; the suite runs as it (see §0.5.2 above).
  Still open: a **production role runbook / installer step** (create the roles, set `DIRECT_URL`) and a check against a managed Postgres whose "superuser" is not a real superuser.
- No branches-and-environments reality yet beyond the documented convention — see that file's own
  honest note on what's aspirational.
