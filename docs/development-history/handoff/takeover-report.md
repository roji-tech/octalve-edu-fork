# Takeover report — local Claude Code session

Written 2026-10-06 at a **stop point, not at the end**: the maintainer asked me to push what is merge-ready. Read this first; it is honest about what is not done.

## 1. Base and head
- Octalve Edu, branch `claude/app-shell-users` (fork `roji-tech/octalve-edu-fork`): **base `78eb3f5`** (the TAKEOVER commit; both masters already contain it, tree `71a8f01dab87`), **head `6d65b0f`** at the time of writing (`git rev-parse HEAD` is authoritative).
- Phase 1 design only: branch `claude/phase-1-0-1-1`, one docs commit `872f9be` on top of `5adbccb` (an earlier head of the branch above) — **not pushed, no code**.
- AlEemaan (separate repo, `roji-tech/AlEemaan`): branch `claude/aleemaan-0.5.G` — see its own `docs/development-history/phases/phase-0.5.G-api-infrastructure.md` once pushed.

## 2. Steps (TAKEOVER.md §2 order)
| Step | State |
| :-- | :-- |
| 1 Baseline green | **Done.** Clean run on 78eb3f5: 1131 tests, 1105 passed, 23 skipped by design, 3 failures — all test/harness defects, fixed (below). |
| 2 Finish 0.5.4 mutation pass | **Done, first pass:** 122 mutations, 102 caught, 19 survived, 1 did not compile. 15 survivors became tests; 5 are justified-equivalent. **The survivors' re-check was started then stopped: the maintainer deferred ALL mutation passes to the end of Phase 2.** Those 15 are therefore written-and-passing but *not yet proven to kill their mutants*. |
| 3 0.5.4 docs | **Done**: `phases/phase-0.5.4-users-invitations.md` (with the mutation table), plan "As built — Users and invitations", CLAUDE.md (0.5.4 rules + the four stale lines), `tests/README.md`, `roadmap-breakdown.md` / `octalve_edu_progress.md` (0.5.2-D T4–T6, 0.5.2-G, 0.5.3, 0.5.4 reconciled against the code). |
| 4 Verify and push | **Done, with one honest caveat** (§4): gate clean, 1145 tests, 0 assertion failures, but 10 timed out on a power-capped machine and pass only with `TEST_TIMEOUT_SCALE=3`. Pushed to `fork claude/app-shell-users`. |
| 5 Lanes proof | **Not started** (optional). The parallel mutation runner uses the lanes and matched the serial runner on six mutations; `test:lanes` itself was never compared with a one-lane run. |
| 6 Phase 1 Slice 1 | **Design only** ("Build design — Phase 1.0 and 1.1", 18 decisions, 5 open questions), on `claude/phase-1-0-1-1`. No migration, no code. |
| 7 AlEemaan port of the Users pages | **Not started.** Before it, AlEemaan 0.5.G (shared API infrastructure) was built, because Users needs it. |

## 3. Mutation testing
- Table: `phases/phase-0.5.4-users-invitations.md` (all 122 rows, results, dispositions). Raw results: `/home/rojitech/octalve-takeover-logs/users-mut.jsonl` (not in the repo).
- **Equivalent (justified in the record):** I2b, M3b, I8d, M17 (an explicit tenant filter sitting on top of RLS), H22 (a type-narrowing guard — the mutant does not compile).
- **Tests added for the other 15:** I5e, I8b, A6, A7, A8, A10, M16, M19, Q11, Q12, Q13, H4, H8, H18, U5 — including **deterministic lost-race tests** for the single-use claim (`whileHeld()` in `tests/integration/invitations.spec.ts`).
- **Pending, by the maintainer's decision:** re-run those 15 with `python3 docs/development-history/handoff/tools/run-mutations-parallel.py docs/development-history/handoff/tools/users-mutations.py <results.jsonl> --lanes 3 --baseline I5e I8b A6 A7 A8 A10 M16 M19 Q11 Q12 Q13 H4 H8 H18 U5` at the end of Phase 2, together with every other deferred pass.

## 4. Test evidence
Gate, in order: `pnpm typecheck` → `pnpm lint` → `pnpm build` → full Playwright suite, one lane, Node 24 (the docs say 22; no issue seen).
- **Full run on the pre-format head (`8b08272`-equivalent source):** 1145 tests = **1112 passed, 23 skipped by design, 10 timed out at 30 s, 0 assertion failures.** Per project: setup 1 · unit 171 · integration 288 · api 323 · e2e-desktop 177 · e2e-mobile 177 · https 8.
- **The 10 timeouts** (`account-self-service.spec.ts:337`; `responsive-and-a11y.spec.ts` :284, :322, :531, :579 on both viewports, :621 on mobile) are a **machine-speed problem**: identical `src/`, lockfile and config passed them in 8–11 s on the clean baseline, but on the machine used for the final run the CPU was held near 800–975 MHz (firmware cap — governor powersave, profile balanced, turbo allowed, on AC through USB-C) and :322 alone took 37 s. All ten pass with the harness's own knob `TEST_TIMEOUT_SCALE=3` (12 passed incl. neighbours). Nothing was skipped, retried or loosened. **Treat this as a risk, not a green tick:** the long axe tests have little headroom (8–17 s of 30 s on a healthy machine). **Please re-run the full one-lane suite on an uncapped machine** to confirm.
- **After Prettier** (a whole-repo reformat, its own commit `7cf6792`, listed in `.git-blame-ignore-revs`): tsc, eslint and build clean; setup + unit + integration + api = **783 passed**. **The browser projects (e2e, https) were not re-run after the reformat** — formatting cannot change behaviour, but it is not evidenced.

## 5. Deviations from TAKEOVER.md and why
1. **Mutation testing deferred** to the end of Phase 2 (maintainer's decision, twice moved later). TAKEOVER required a pass per phase.
2. **A parallel mutation runner** (`handoff/tools/run-mutations-parallel.py`) instead of the serial one — to use the machine; parity checked on six mutations.
3. **The mail-outbox reader now throws on corruption** and the setup project empties the file each run (found as the root cause of 63 spurious failures); a CSP test that could pass against a report-only policy was made real; a rate-limit test's arithmetic was corrected. All test-side, each proven to fail against the old behaviour.
4. **Prettier added** at the maintainer's request (no formatter existed): `.prettierrc.json` (printWidth 140, double quotes, trailing commas), `.prettierignore` (markdown, docs, migrations, lockfile, build output), scripts `format` / `format:check`.
5. **Phase 1 branch was cut from an earlier local head**, not from the pushed head, because the design is docs-only; rebase it onto `claude/app-shell-users` (or master once merged) before building.

## 6. Security-sensitive spots for a second pair of eyes
- `src/lib/invitations/service.ts:294` — `setTenantContext(tx, trustedTenantId(found.tenantId))`: the tenant is taken from the invitation row the secret named. The only legitimate non-wizard use of `trustedTenantId`; check nothing before it can be reached with a row the caller does not hold.
- `src/lib/invitations/service.ts:305` — the single-use claim (`updateMany` + count). Its conditions only matter under a race; now covered by deterministic tests, **mutation re-check pending**.
- `src/lib/invitations/service.ts:286` — "an existing account is attached only by its owner" (`WRONG_ACCOUNT`).
- `prisma/migrations/20261009090000_users_invitations/migration.sql:55-61` — `app_invitation_hash()` (NULLIF-guarded) and the extra read path in `invitation_read`.
- `src/lib/members/service.ts:113` — the `FOR UPDATE` lock behind "the last active ADMIN cannot be demoted or deactivated".
- `tests/support/outbox.ts:9` — the strict reader (a harness change that every mail test depends on).
- AlEemaan, `src/lib/auth/csrf.ts` — **rollout risk on a LIVE school**: `X-Forwarded-Host` is no longer trusted by default. A reverse proxy that rewrites `Host` will make every write fail the Origin check until it passes `Host` through (nginx: `proxy_set_header Host $host;`) or `TRUST_FORWARDED_HOST=true` is set with a proxy that overwrites the header. **Check the deployment's proxy before releasing.**

## 7. Known gaps and risks
- Timing-sensitive axe tests with thin headroom (above). `account-self-service.spec.ts:337` is a statistical timing test; it is sensitive to a slow machine.
- Admin-initiated email change (0.5.4-F) deliberately not built.
- The lanes (`test:lanes`) were never compared with a one-lane run test-by-test.
- A stray `next start -p 3187` process predates this session and is not mine.
- Plan §1.2 sketches omit `tenantId` on child tables (the catalog guard would fail them) and the plan's §1.x numbering clashes with the roadmap's 1.x; both reconciled in the Phase 1 design, not in the older sketches.

## 8. Open questions for the maintainer (carried from the Phase 1 design)
1. Does a campus session **shadow** the school-wide one, or should a school choose one mode?
2. `schoolType` defaults to K12 and the wizard does not ask until Settings (roadmap 1.7) — acceptable?
3. Is `CLOSED` terminal for an academic session, or is a "reopen" ever wanted?
4. Grade bands as half-open contiguous ranges rather than the printed "70–74" style?
5. Grade scale per class group deferred — fine for now?
6. AlEemaan: what populates the two Arabic branches' data today, and where does the school name for the 0.5.2 Settings seed come from (the wizard stores none)?

## 9. Verify in five minutes
```
git fetch fork && git checkout claude/app-shell-users      # head: see §1
pnpm install && pnpm exec prisma generate
pnpm typecheck && pnpm lint && pnpm format:check && pnpm build
pnpm exec playwright test --project=unit --project=integration --reporter=dot       # ~1 min on a healthy machine
# the whole suite (~15 min healthy; add TEST_TIMEOUT_SCALE=2 on a slow machine):
pnpm test
```
Needs Postgres on 5433 (`docker compose up -d db`), `redis-server` on PATH, Chromium, `openssl`. `.env`: `DATABASE_URL` = `app_user`, `DIRECT_URL` = the owner.
