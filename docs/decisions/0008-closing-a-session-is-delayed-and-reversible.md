# 0008 — Closing a session is delayed, can be forced with the password, and can be reopened
Status: accepted · Decided: by the maintainer, 2026-10-07 (refines the "CLOSED is final" rule of Phase 1.1) · Recorded: 2026-10-07

## Context
Phase 1.1 made `close` instant and `CLOSED` permanent: results, fees and reports will point at a closed session, so reopening it silently could rewrite history. But a mistaken click at year-end was then unrecoverable from the screen.

## Decision
- **Closing is scheduled, not instant.** `close` sets `closeAt = now + 24 h`; until then the session is fully `ACTIVE` and the administrator can cancel. Asking again keeps the sooner time.
- **Forcing needs proof.** `close` with the administrator's own password sets `closeAt = now + 1 minute`; the proof is rate-limited per account and never logged. Ending a year on the spot (`activate … closeCurrent`) needs the same proof.
- **No scheduler.** A pure `effectiveStatus` makes a due session read-only the instant it is due, and `settleDueClosings` writes it down — lazily, exactly once (a conditional update), attributed to whoever asked.
- **Reopening is possible, with a typed reason (5–300 characters, audited), only while no other session of the same scope is active.** A reopened session can be closed again the same way.

## Consequences
Every session read and write settles due closings first, so a GET may write one audit row. A scheduled close does not make room for the next session until it takes effect. Times are shown in the viewer's own time zone (the school has none yet).

## Enforced by
`tests/unit/academic-rules.spec.ts` (`effectiveStatus`, the two delays), `tests/integration/academic-session-closing.spec.ts` (schedule, force, cancel, settle once under concurrency, read-only when due, reopen rules, rollback, cross-school), `tests/api/academic-sessions.spec.ts` (password proof, rate limit, never echoed, role matrix), `tests/e2e/academics.spec.ts` and the axe states in `responsive-and-a11y.spec.ts`. Migration `20261014090000_session_close_timer`.

## Related
Plan "Design change — closing a session takes time" · ADR 0002 (the reopen path rolls back after a lost race) · ADR 0004 · `phases/phase-1.1-academic-structure.md`.
