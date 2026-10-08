# Decisions (ADRs) — Octalve Edu

One short file per decision that someone might later **reverse by mistake**, or that **cost real effort to learn**. Not every change gets one.

| Document | Role |
|---|---|
| `development-history/octalve_edu_progress.md` | what is built |
| `development-history/domain-implementation-plan.md` | the design record ("Build design", "As built") |
| `development-history/phases/*.md` | append-only history per phase |
| `docs/decisions/` (here) | the decisions and the reasons, half a page each |
| `/home/rojitech/Desktop/CODEC/out/tasks.md` | the task tracker (workspace, not in git) |

Plans and phase records link to the ADR instead of re-arguing the reason.

## Rules
- Files are `NNNN-short-title.md`, numbered in the order they are written.
- **Never edit an accepted ADR's decision.** To change a decision, write a new ADR that supersedes it, and change the old one's status to `superseded by NNNN`. The only other edits allowed: the status line, typos and broken links.
- Keep it to about half a page. Fields: Title, Status, Decided, Recorded, Context, Decision, Consequences, **Enforced by** (the test, trigger or file that holds it in place), Related.
- *Decided* is when the decision was made (a phase is fine if the date is not known); *Recorded* is when this file was written. Many first ADRs record decisions made earlier.
- AlEemaan has its own `docs/decisions/`. Where a decision is shared, each repo has its own ADR and links to the other.

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
| [0010](0010-school-type-is-a-server-setting.md) | School type comes from the server, never the browser or a school's administrator | proposed |
