# Architectural Decision Records (ADRs) — Octalve Edu

One short file per decision that someone might later **reverse by mistake**, or that **cost real effort to learn**. Not every change gets one.

| Document | Role |
|---|---|
| `development-history/octalve_edu_progress.md` | what is built |
| `development-history/domain-implementation-plan.md` | the design record ("Build design", "As built") |
| `development-history/phases/*.md` | append-only history per phase |
| `docs/adr/` (here) | the decisions and reasons, half a page to one page each |
| `/home/rojitech/Desktop/CODEC/out/tasks.md` | the task tracker (workspace, not in git) |

Plans and phase records link to the ADR instead of re-arguing the reason.

## Rules

1. **One decision per file**, titled as the decision ("Money crosses the API as integer kobo"), not as the topic ("Money").
2. **`NNNN-kebab-title.md`.** Four digits, the next free number, never reused or renumbered. If two open PRs claim the same number, the later one renumbers before it merges.
3. **Status** is `Proposed`, `Accepted`, `Rejected`, `Deprecated` or `Superseded`. Write `Accepted` when the decision has been made and the PR records it. Write `Proposed` only while it is still open, and let the PR that settles it change the Status and the Date. Keep rejected ones: "we looked at this and said no" is worth finding.
4. **An accepted ADR is not rewritten.** Fix a typo or a dead link in place. Anything that changes the meaning is a new ADR that says `Supersedes: NNNN`, and the old one becomes `Superseded` with `Superseded by: NNNN`. The old text stays, because its value is what was known at the time.
5. **Land it with the change.** When a decision comes with code in this repo, the ADR is in the same PR, so the reason and the change arrive together. A backend-only decision gets its own small PR here, and the backend PR cites the number. A decision made ahead of the code lands alone.
6. **Name who decided, and when.** `Date` is the day the decision was made (UTC), not the day it was written down. `Decided by` is the person who could have said no. An agent may draft an ADR; only a person can accept it.
7. **Say what enforces it.** A gate (`pnpm run verify-…`), a test, or `review only`, written out. Prose is not a check: where a decision has already cost money once, add the gate in the same change.
8. **Write the downsides and the alternatives.** Consequences list what gets harder, what is being accepted, and what would make us revisit. Each alternative says why not. An ADR with only benefits is a sales page.
9. **Backfilling is allowed and must be honest.** Add a `Backfilled` line, date the decision by the commit that introduced it, and cite that commit. Where the reasoning was never written down, say so; do not reconstruct a context nobody recorded.
10. **Treat an accepted ADR as a constraint.** If a change would contradict one, stop and propose a superseding ADR instead of working around it. Code that enforces or depends on a decision cites it in a comment (`ADR-0007`), and the ADR lists the files and documents it binds (`Binds`).
11. **Short, and no secrets.** One page, two at most; link out for detail. No passwords, tokens, customer names or real employee data.

---

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-rls-and-composite-foreign-keys.md) | Tenant isolation is row-level security plus composite foreign keys | accepted |
| [0002](0002-a-refusal-after-a-write-must-roll-back.md) | A refusal that can follow a write must roll back | accepted |
| [0003](0003-locks-are-database-triggers.md) | "Locked" is enforced by database triggers | accepted |
| [0004](0004-archive-never-delete.md) | Academic records are archived, never deleted | accepted |
| [0005](0005-marks-in-hundredths-and-half-open-bands.md) | Marks are integers of hundredths; grade bands are half-open | accepted |
| [0006](0006-admin-implies-permissions-not-roles.md) | ADMIN implies permissions, not roles; only an ADMIN grants | accepted |
| [0007](0007-mutation-passes-deferred-to-end-of-phase-2.md) | Mutation passes are deferred to the end of Phase 2 | accepted |
| [0008](0008-closing-a-session-is-delayed-and-reversible.md) | Closing a session is delayed, can be forced with the password, and can be reopened | accepted |
| [0009](0009-enrolment-is-per-session.md) | Enrolment is per session, not per term | accepted (default) |
| [0010](0010-school-type-is-a-server-setting.md) | School type comes from the server, never the browser or a school's administrator | accepted |
| [0011](0011-branching-dev-master-prod-and-merge-approval.md) | Development on `dev`; `master` needs approval; `prod` reserved; octalve-core is writable | accepted |
| [0012](0012-the-docker-databases-are-local-dev-databases.md) | The docker databases are local dev databases with full access | accepted |
| [0013](0013-commit-and-pr-messages-are-comprehensive.md) | Commit and PR messages are comprehensive | accepted |
| [0014](0014-audited-override-for-namesake-student-registrations.md) | Audited in-place override for namesake student registrations | accepted |
