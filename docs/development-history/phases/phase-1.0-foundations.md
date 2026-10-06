# Phase 1.0 — Foundations (school type, school settings, permissions)

**Status: BUILT (2026-10-06); full one-lane gate and the mutation pass PENDING** — the full-suite run happens when Phase 1.1 lands (one run for the slice); **all Phase 1 mutation passes are deferred to the end of Phase 2 by the maintainer's decision.** What *was* run is listed below.
Branch `claude/phase-1-0-1-1` (from the merged master `cc3479a`). Design of record: plan §"Build design — Phase 1.0 and 1.1", decisions 1–6, committed alone before any code. Roadmap: `roadmap-breakdown.md` §1.0.

## What this delivers
- **`Tenant.schoolType`** (`K12 | HIGHER_ED | VOCATIONAL`, default K12 — every school today is one; the wizard does not ask until the Settings screen exists).
- **`SchoolSettings`** — one row per school, tenant id as the primary key, the ten §1.3 columns with the **secure defaults** (results need approval; teaching staff need MFA; nothing automatic). **Made by the database:** a trigger on `Tenant`
  inserts the row, whichever code created the school (the setup wizard, a test helper, hand-run SQL). Because the table is under `FORCE` RLS and the wizard sets the tenant context only *after* creating the tenant, the trigger sets
  `app.tenant_id` for its one insert and **puts the caller's previous value back** (it must never leave a caller in another school's context). The migration backfills existing schools first, idempotently. `getSchoolSettings(tx, id)` **throws**
  on a missing row rather than inventing defaults. No write path and no screen yet (roadmap 1.7). RLS: SELECT/INSERT/UPDATE for the tenant; **no DELETE policy** (the row goes with its school).
- **`Permission` and `TenantMembership.permissions`** — `CAN_APPROVE_RESULTS | CAN_MANAGE_FINANCE | CAN_PUBLISH_CONTENT | CAN_MANAGE_USERS`. A **CHECK constraint** says permissions exist only on staff roles
  (`permissions = '{}' OR role IN ('TEACHING_STAFF','NON_TEACHING_STAFF')`), so no write path can give a parent or an administrator one.
- **`withAuth({ tenant: true, roles?, permissions? })`** — the decision is one pure function, `lib/auth/authorize.ts`: no options → any member; `roles` only → the role is listed (an ADMIN is **not** implied, so a teachers-only route stays
  teachers-only); `permissions` given → the role is listed **or** the member is an ADMIN (it implies every permission) **or** holds a listed one. `permissions` needs `tenant: true`, must be a non-empty list of real values (a typo or `[]`
  throws at construction). The resolver returns the membership's permissions with the role, read from the database on every request, so a grant or revoke takes effect on the person's **next request**, a deactivated member holds none, and a permission
  held in one school is not honoured in another. One 403 body whichever way it refuses.
- **Granting on the Users page.** `PATCH …/members/[userId]` accepts `permissions` (the **full desired set**, validated, no duplicates). ADMIN only and **never delegable** (a grant-permissions power would be an escalation path; `CAN_MANAGE_USERS` is stored but consumed
  by no route yet); not yourself (`SELF`); only on staff roles (`PERMISSIONS_NOT_APPLICABLE` otherwise); **moving a member to ADMIN or a non-staff role clears theirs in the same transaction**, and the audit entry (`MEMBER_PERMISSIONS_CHANGED`, before/after)
  says so (`clearedByRoleChange`); a no-op writes nothing; a deactivated member's cannot be edited. The Edit dialog offers four plain-language checkboxes to staff only, says what each does, and warns before a role change removes them; the list shows "Extra: …".

## Verification (what ran; the full gate is pending, see above)
`pnpm typecheck` and `pnpm lint` clean throughout; `pnpm build` clean; Prettier-formatted. **Run and passing:** unit — `authorize` truth table (7), `with-auth` construction rules; integration — `phase-1-0-foundations` (schoolType, every creation path, context restore, backfill idempotence, missing-row error,
cascade, FK, the CHECK on every write path), `permissions` (8: per-school scope, ADMIN implied, role OR permission, roles-only does not widen, deactivation, next-request effect), `members` (20, incl. 3 new), `rls` (48: SchoolSettings policies incl. write checks that read nothing,
catalog guard lists the table); api — `members` + `setup` + `tenant-boundary` (58; the wizard yields a settings row); browser, both viewports — `users` (29, incl. the permissions journey) and the Users block of `responsive-and-a11y` (3) with the new dialog states checked by axe in **both themes**
(staff: permissions offered; a permission ticked; a role that cannot hold them).
**Mutation pass: NOT RUN (deferred to the end of Phase 2).** The list is in the plan's design section ("Mutation plan — 1.0") and is the first thing to run then.

## Findings and decisions
1. The brief's "ADMIN implies every permission" is applied to the `permissions` option **only**. Implying roles would silently open every role-restricted route to administrators and change tested behaviour. (Flagged for the maintainer's review.)
2. A trigger beats application code for "every school has a settings row": it needs no change when a new creation path appears. The cost — a trigger that touches a session setting — is contained by restoring the caller's value and by a test that proves it.
3. The catalog guard (`rls.spec.ts`) names the tenant-scoped tables explicitly; adding `SchoolSettings` to its list was the intended friction.
4. A member's `permissions` shape appears in the members API (`permissions: []` always present) — the exact-keys assertions in `tests/api/members.spec.ts` and `tests/integration/members.spec.ts` changed accordingly.

## Not done (and why)
- No settings UI or write path (roadmap 1.7, with step-up MFA). No route consumes any permission yet (first consumers: `CAN_APPROVE_RESULTS` in 1.4, `CAN_MANAGE_FINANCE` in 1.5, `CAN_PUBLISH_CONTENT` in 1.6).
- Mutation pass; full-suite gate (both pending, above).
