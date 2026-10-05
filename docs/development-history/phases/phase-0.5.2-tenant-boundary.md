# Phase 0.5.2 — Tenant trust boundary: the application layer **and** row-level security

**Status: BUILT AND VERIFIED (2026-10-05). The application layer landed first on `claude/tenant-trust-boundary`; the database half (row-level security,
the `app_user` runtime role, the suite running as that role) is `claude/tenant-rls`, stacked on it.** Design of record: plan §0.5.2 and "Build design
for §0.5.2" (written before any code). Roadmap position: `roadmap-breakdown.md` §0.5.2-A…G. The app shell (§0.5.2-H) and the Users pages (§0.5.4) are the next
step and are designed in the plan ("The app shell, and the Users pages with invitations"); Phase 1 tables may now start — **each ships RLS in the same migration**.

## What this delivers
The URL's `[code]` is a **lookup key, never a claim**. A request becomes "acting for school X" only after the signed-in person's
*own* membership in X has been found; nothing else produces the branded `VerifiedTenantId` that tenant data access demands.
- **`lib/tenant/verified-tenant.ts`** — `VerifiedTenantId` (a branded string; a raw string does not compile — proved by
  `@ts-expect-error` lines in `with-auth.types.ts`) and its one constructor `trustedTenantId()`. ESLint confines it, and the raw
  `prisma` client, **out of** `src/app/schools/**` and `src/app/api/v1/schools/**` (and a unit test lints virtual files at those paths
  to show the rule fires).
- **`lib/tenant/for-tenant.ts`** — `forTenant(id).transaction(fn)` / `forUser(id).transaction(fn)`: ONE interactive transaction, the
  context set first with `set_config(name, $1, true)` — a bind parameter (an id full of SQL stays a string) and **transaction-local**
  (proved on a one-connection pool: nothing leaks to the next transaction or query). `setTenantContext` for code that creates a tenant
  and its first rows atomically.
- **`lib/tenant/resolve-tenant.ts`** — validate the code → (Solo: assert exactly one tenant, else **500 fail closed**, and match the URL
  code against it) → look up the caller's membership (SaaS: in the tenant with that code; Solo: in the install's one tenant **by id**)
  through the user context. **Unknown, malformed and "not a member" are one 403.** An ADMIN of school A is not an admin of school B; a
  person in two schools gets each school's own role.
- **`withAuth(handler, { tenant: true, roles })`** — resolves the school from `params.code`, passes `auth.tenant` (verified id, code, name,
  role, campus, `run(fn)`); `roles` is checked against the role **in that school** (never "any membership"); a role that isn't allowed
  gets the *same* 403 body as no access; `roles` without `tenant: true` is a type error and a throw; `permissions` stays unavailable
  until §1.7. CSRF and 401 run before any tenant is looked up, so a signed-out probe learns nothing about which schools exist.
- **Existing code moved onto contexts:** `auditPersonEvent` (one row per school, each in its own tenant context), `getUserMemberships`
  and `completeSignIn`'s admin check (user context), the setup wizard (tenant context set in its own transaction), `scripts/mfa-reset.mjs`.
- **Routes and pages:** `GET /api/v1/schools/[code]` (role + the campuses that role may see; the query is scoped to the tenant **and** runs
  in the tenant context — belt and braces); `/schools/[code]` workspace; a real **HTTP 403** view (`forbidden()`, `experimental.authInterrupts`)
  that names nothing; **`/dashboard` is now the front door** — one school redirects in, several get a picker, none get an honest message.
- **Test harness:** a **fifth server in `DEPLOYMENT_MODE=saas`** (`SAAS_PORT` 3103) because the Solo servers rightly fail closed when a second
  tenant exists; `createTenant` / `addMembership` / `removeCreatedTenants`; a shared `withEnv`.

## Verification
`pnpm test`: **811 passed, 5 skipped by design, 0 failed** (17.4 min; it was 740) — unit 123, integration 161, api 253, e2e-desktop 135
(+1 skipped), e2e-mobile 135 (+4), https 8. `tsc`, ESLint, `next build` clean. New: **unit** (withAuth option refusals, lint guards);
**integration** — resolver (member, role per school, all refusals identical, ADMIN-of-A-is-not-admin-of-B, removal takes effect at once,
Solo: one tenant / second tenant → 500 / none → 500 / malformed code stays 403 / membership still required), the `withAuth` wrapper
(roles, role in the wrong school, revoked session, CSRF before tenant, missing params), the context (bind parameter, transaction-local on a
one-connection pool, rollback), audit per school, memberships; **api** — on the SaaS server: roles and campuses, cross-tenant 403 for an admin, a
teacher and a person with no school, **another / unknown / malformed code indistinguishable**, 401 identical for real and unknown codes,
ended session, removed membership, hostile school names as plain JSON, and **every route under `/api/v1/schools/` discovered from the file
system** and hit cross-tenant, signed out and as a person with no school (a route added without the check fails); Solo server — one school,
second tenant → 500 naming nothing; **browser** (desktop + phone) — routing (one / several / none), tampering with the code → 403 view naming
nothing and identical for a real and an unknown school, hostile names inert; axe in both themes + tap targets for picker, workspace (admin,
staff, no campus) and the 403 view. The existing suites were adapted to the front door (`HOME_URL`).

### Mutation testing — 25 injected bugs, all caught or equivalent
The resolver (anyone's membership accepted; "not a member" answering differently; Solo invariant dropped; Solo ignoring the URL code; no
lower-casing; no format check); the context (session-level instead of transaction-local — for tenant and user; context never set; id check
dropped); `withAuth` (roles unchecked; role denial with a different body; tenant resolved before the session; a misconfigured install answered
403); memberships for every user; audit for the first school only; the route (non-admin sees every campus; query unscoped; handler not
wrapped — a **compile error**); the front door (multi-school person redirected; the 403 view naming the school). **Three survivors, all
instructive:** T4 and T6 were real — the Solo URL-code check was *redundant* because the membership lookup matched by code (Solo now looks up by the
tenant's id, which makes the check load-bearing) and the format check had no observable effect (a test now pins that garbage is refused before the
install's state is consulted); W4 (a missing `params` read as the code `"x"`) and T11 (Solo looking the tenant up by code after the code was already
matched) are **equivalent** — same outcome either way.

## Row-level security (added 2026-10-05, branch `claude/tenant-rls`)
The application layer above made every request name its school through a verified membership. This is the net **under** it: even a query that forgot
`where: { tenantId }` — or a bug in the layer above — cannot read or write another school's rows, because the database refuses.

**Two roles, two connection strings.** `DATABASE_URL` is the runtime role **`app_user`** (`LOGIN NOSUPERUSER NOBYPASSRLS`, data privileges only: no DDL, no
access to Prisma's `_prisma_migrations`); `DIRECT_URL` is the migrator that owns the tables and runs `prisma migrate` (`datasource` has `directUrl`, which Prisma uses for
the CLI and never for the client). The role is a cluster-level object, so it is created by infrastructure, not by a migration: `docker/postgres/init/01-roles.sql`
(a fresh compose volume), **`pnpm db:roles`** (an existing database — also re-applies the grants; prints the exact SQL when it may not create the role), or the test
setup (when the admin may create roles). The migration then grants it privileges through a function, **`app_grant_runtime_privileges()`** — `USAGE`, DML on every
table, nothing on `_prisma_migrations`, **no `UPDATE`/`DELETE`/`TRUNCATE` on `AuditLog`**, and `ALTER DEFAULT PRIVILEGES` so a later migration's table is granted without
anyone remembering. (It is a function so `db:roles` can re-run it and a later append-only table can call it again.)

**Migration `20261008090000_tenant_rls`.** Two `STABLE` SQL functions read the transaction-local context — `app_tenant_id()` and `app_user_id()` — each `NULLIF(…, '')`
(a pooled connection reads a setting back as the *empty string*, not NULL, after a transaction that set it; empty → NULL → no row matches → an unset context is **zero rows
and no writes**). Then, for every table that has a `tenantId`: `ENABLE` **and `FORCE`** row-level security and policies with **both `USING` and `WITH CHECK`**:
- `Campus` — `campus_tenant_isolation` (all commands).
- `AuditLog` — `audit_read` (SELECT) and `audit_insert` (INSERT) **only**: no UPDATE or DELETE policy **and** the privileges revoked — two independent locks, each tested separately.
- `TenantMembership` — the table the plan had listed both as tenant-scoped and as an identity table (finding 1): a **two-path** policy. *Read:* the row's tenant is the context's **or** the row
  is the context user's own (that is how a person's schools are found before any tenant is known). *Insert/update/delete:* **tenant context only**, so nobody can grant
  themselves a role or join a school through the user path.

**`assertRlsEnforced()`** (`lib/tenant/assert-rls.ts`) — "RLS is inert unless the role that connects really has it enforced" is checked, not assumed. Once per process, before the
first tenant resolution, it asks Postgres who the app is: superuser? `BYPASSRLS`? owns the tables? any table with a `tenantId` lacking *enabled + forced* RLS? In
**production** a problem makes `resolveTenant` return the fail-closed 500 (`TENANT_MISCONFIGURED`, the cause in the server log, nothing about it in the response) unless
`ALLOW_RLS_BYPASS=true`; elsewhere one warning. A refusal — and a failure to even ask (database briefly down) — is **not remembered**: the next request asks again
(found by review: the first version memoised a rejected promise, so one bad moment would have poisoned the process).

**Harness: the suite runs the way production does.** `TEST_DATABASE_URL` is the **admin** (creates the database, migrates, arranges fixtures — `db`, `resetDatabase`) and **must
bypass RLS** (a superuser, or `BYPASSRLS`); everything else — every in-process module and **every `next start` server** — connects as `app_user`. `database.setup.ts` verifies both
(and prints the exact `ALTER ROLE … BYPASSRLS;` / `CREATE ROLE …` when one fails). A **sixth server** (`UNSAFE_RLS_PORT` 3105) is deliberately connected as the table owner, to prove the
assertion is *wired in*: it answers tenant routes with a generic 500, renders no school page, and still serves routes that touch no tenant.

**Tests.** `integration/rls.spec.ts` (33, all as `app_user`): *who is running* (not super / no bypass / owns nothing; the admin **is** exempt, which is why fixtures go through it); the verdict
matrix; `assertRlsEnforced` (production refuses, the refusal is not remembered, the escape hatch warns once, a database failure is not remembered); no DDL / no ledger; *no context = no
rows* for all three tables, no writes, and an empty-string context is no context; *tenant isolation* — A reads A's, never B's, even **by id**; `WITH CHECK` stops an insert **and a move** into
B; a cross-tenant UPDATE/DELETE affects 0 rows; own rows are writable; the context **does not leak on a one-connection pool**; *AuditLog* — own rows only, a forged tenant refused, UPDATE/
DELETE/TRUNCATE refused outright, **and** (privilege lifted for the test, always taken back) still unchangeable because no policy admits it; *TenantMembership* — the user context reads
exactly that person's memberships across schools, the tenant context the whole roster of one school, the user path cannot insert, a tenant cannot add a member to another school; and the **catalog
guard**: every table with a `tenantId` has RLS enabled **and forced** and a policy, the tables *without* one are exactly the reviewed identity list (`User, Session, PasswordResetToken,
EmailChangeToken, MfaCredential, MfaRecoveryCode, MfaChallenge, Tenant, SystemSettings, _prisma_migrations`), every writable policy has `USING` and `WITH CHECK`, and a table created by a later
migration is granted automatically. `api/rls-assertion.spec.ts` (4) drives the sixth server. **Every existing suite ran unchanged as `app_user`.**

**Verification (final, 2026-10-05, branch `claude/tenant-rls`):** `pnpm test` — **932 passed, 5 skipped by design, 0 failed** (19.1 min; it was 811 before 0.5.3 and the RLS work): setup 1, unit 154, integration 224, api 280, e2e-desktop 134
(+1 skipped), e2e-mobile 131 (+4), https 8. Every `next start` server and every in-process module ran as `app_user`; the fixtures ran as the bypassing admin. `tsc`, ESLint and `next build` are clean. One test —
the 40 ms timing-parity check on `POST /email-change/request` — failed once in a long run on a loaded machine and passed on its own and in the final run; it is statistical by design (see `tests/README.md`, Known limits), not an RLS effect.

### Mutation testing — row-level security: 44 injected bugs, 43 caught, 1 equivalent (9 survived the first pass and drove stronger tests)
*The migration, each applied to a freshly built test database:* RLS not **enabled** (policy present but inert) or not **forced** on `Campus`, `AuditLog`, `TenantMembership`; `WITH CHECK (true)` on `Campus`, on
`AuditLog` inserts, on `TenantMembership` inserts and updates; `USING (true)` on `Campus` and on the `AuditLog` and membership **read** policies; a membership **user path** that can read everyone, insert, update or delete;
no user path to read; an `UPDATE` policy added to `AuditLog`; the `UPDATE/DELETE/TRUNCATE` revoke removed; `app_tenant_id()` reading the *user* setting and the reverse; strict `current_setting` (an unset context raising);
the runtime role granted the migration ledger, `ALL` privileges, `CREATE` on the schema, no default privileges, or no grants at all. *The application:* `set_config(…, false)` for the tenant and for the user (session-wide context
leaking to the next request on a pooled connection); the context never set (tenant and user); each check inside `assertRlsEnforced` removed in turn (superuser, `BYPASSRLS`, ownership, unprotected tables); the verdict never refusing,
ignoring the escape hatch, or refusing outside production; a refusal remembered; a pass not remembered; the resolver not running the assertion, answering a refusal with a 403, or carrying on.
**Nine survived the first pass — all real gaps in the tests, none in the policies:**
- **S3 / S8 / S16 — `WITH CHECK (true)` on `Campus`, the audit insert and the membership update.** The assertions used Prisma `create`/`update`, which issue `INSERT/UPDATE … RETURNING`; Postgres also runs the **read** policy on a
  returned row, so the write was refused *by `USING`* and a broken `WITH CHECK` went unnoticed. Now the tests also use `createMany`/`updateMany` (nothing returned), and one raw `UPDATE … SET "tenantId" = …` with **no WHERE** (it reads
  no column, so no read policy is consulted) for `Campus` and `TenantMembership`. Worth remembering for every future policy: **test the write check with a statement that returns nothing and reads nothing.**
- **S25 — `GRANT ALL`.** Only `UPDATE` on `AuditLog` and DDL were asserted. A test now lists the runtime role's *exact* privileges per table (four verbs; two on `AuditLog`; none on the ledger; no `CREATE` on the schema).
- **A5–A8 — each branch of `assertRlsEnforced`.** The matrix test fed the verdict synthetic reports, and the real-role test only proved the two extremes. `checkRlsEnforcement` is now tested with stand-in clients that set
  one flag at a time (exact messages), against a real forgotten tenant table (found; "enabled but not forced" still found; forced → clean), and against the real admin.
- **S21 — `NULLIF(…, '')` dropped: equivalent.** `'' = "tenantId"` is simply false (no row has an empty tenant id). It stays as defence in depth; the empty-string-context test documents the behaviour it protects.
- **S5 — `WITH CHECK` omitted from an `ALL` policy** is *behaviourally* equivalent (Postgres reuses `USING`), but the catalog guard ("every writable policy has both") **fails it**, so the intent cannot be dropped silently.

## Findings and decisions
| # | Found by | What | Resolution |
| :-- | :-- | :-- | :-- |
| 1 | Reading the plan | `TenantMembership` was listed both as RLS-scoped and as an identity table that must be readable before a tenant is known. | One table, a two-path policy (tenant **or** own user to read; tenant only to write) — designed, to be built with RLS. |
| 2 | The front door | Every existing browser test assumed "signed in = `/dashboard`"; a one-school person now lands in their school. | `HOME_URL` helper; the school page keeps a "Welcome, name" heading so the markers stay meaningful. |
| 3 | Harness | A Solo server with two tenants is (correctly) a 500, so multi-school tests cannot share it. | The SaaS-mode server; specs create and remove their own schools. |
| 4 | Mutation T4/T6 | Solo's code check and the format check were observably redundant. | Solo resolves by tenant id; a test pins the ordering. |
| 5 | Design | `forbidden()` is experimental in Next 16. | It gates only the status code and view; the authorization decision is ours. Verified a real 403 in the production build. |
| 6 | RLS build | A policy written `FOR ALL … USING (x)` with **no** `WITH CHECK` reuses `USING` for writes, so "drop the WITH CHECK" is an *equivalent* mutation for `Campus` — the test that matters is a `WITH CHECK (true)` one. | The catalog guard still demands both clauses on every writable policy, so intent is explicit; the mutation pass uses `(true)`. |
| 7 | RLS build | `NULLIF(…, '')` is **defensive**: with it dropped, `'' = "tenantId"` is simply false (no row has an empty tenant id), so behaviour is identical. | Kept, documented as defence in depth; recorded as an equivalent mutation. |
| 8 | Review | `assertRlsEnforced()` memoised its promise — a rejected first check (database blip) would have made **every** later tenant request fail until restart. | Failure is never remembered; tested with a failing client then a good one. |
| 9 | Harness | A non-superuser admin cannot `SET ROLE app_user`, so a test built on that fails in this environment. | The policy-lock test grants as the admin, acts as the *real* runtime role, and always revokes (`finally`). Tests must not assume the admin is a superuser. |
| 10 | Test run | `Prisma.directUrl` makes `DIRECT_URL` required wherever the Prisma **CLI** needs a connection (`migrate`); the client and `generate` are unaffected. | Documented in `.env.example`, the Solo notes and `tests/README.md`; the dev `.env` carries both. |

## What is not done (and why)
- **The app shell (0.5.2-H) and the Users pages / invitations (0.5.4)** — designed (plan: "The app shell, and the Users pages with invitations"), next on this track.
- **A restore drill and a production role runbook.** `pnpm db:roles` and the init script cover development and the docker install; the Solo **installer** and a production runbook that
  creates the roles and sets `DIRECT_URL` belong to the deployment work (Phase 7-equivalent for this product) — the application already refuses to serve on a bypassing role in production.
- **Unverified here:** behaviour against a *managed* Postgres whose "superuser" is not a real superuser (RDS/Cloud SQL). The harness's admin requirement ("superuser or `BYPASSRLS`") and the
  `app_user` grants are plain SQL and should carry over, but that has not been run.
