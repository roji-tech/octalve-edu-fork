# 0002 — A refusal that can follow a write must roll back
Status: accepted · Decided: Phase 1.1 (found by the tests) · Recorded: 2026-10-07

## Context
Our services *return* refusals (`{ ok: false, reason }`) instead of throwing. Returned from inside a transaction, a refusal lets the transaction **commit** whatever was written before it. This happened: a new scheme version archived its predecessor and *then* found the name taken (old version gone, no successor); activating a session with `closeCurrent` closed the open session and *then* found the target was not `PLANNED`; set-current and make-default could clear the old pointer and then refuse after a lost race.

## Decision
Check before the first write wherever possible. Where a refusal can still follow a write, throw so the transaction rolls back: `refuseAndRollBack(reason, detail?)` inside `rollingBack(() => tenant.run(…))` (`lib/academics/sessions.ts`).

## Consequences
New services that write and then may refuse must use the helpers or reorder. A new version checks its name before archiving the predecessor.

## Enforced by
Regression test in `tests/integration/academic-sessions.spec.ts` (the open session stays open); the concurrency tests in `academic-scoring.spec.ts`. Mutation targets are listed in the plan, "Mutation plan" 1.1.

## Related
`phases/phase-1.1-academic-structure.md` finding 1 · `CLAUDE.md` Phase 1.1 rules.
