# 0007 — Mutation passes are deferred to the end of Phase 2
Status: accepted · Decided: by the maintainer, during Phase 1 · Recorded: 2026-10-07

## Context
Mutation testing (inject the bug a test claims to catch, see it fail) was run per phase through 0.5.x. It is slow on this CPU-capped machine and the Phase 1 code has few consumers yet.

## Decision
Phase 1 and Phase 2 mutation passes run **together at the end of Phase 2**. Until then the mutation *lists* are written in each phase's design ("Mutation plan") and docs say **pending**. A phase is not described as mutation-tested before then.

## Consequences
Survivors will be found late; the lists must stay current. The runner is `handoff/tools/run-mutations-parallel.py`.

## Enforced by
Convention only (docs say "NOT RUN — pending"); `tasks.md` carries the item.

## Related
`phases/phase-1.1-academic-structure.md` "Not done" · `handoff/phase-1-slice-1.md` §5.
