# 0005 — Marks are integers of hundredths; grade bands are half-open
Status: accepted · Decided: Phase 1.1 · Recorded: 2026-10-07

## Context
With floats, `0.1 + 0.2 ≠ 0.3`, so "components plus exam equals the total" would refuse or accept by accident. A band table written "70–74 / 75–100" leaves 74.5 in no band.

## Decision
Marks are compared as integer **hundredths** (`lib/academics/scoring.ts`); more than two decimals, or a non-finite number, is refused rather than rounded. Components plus exam must equal the total exactly. Grade bands are **half-open** `[min, max)`, contiguous, covering 0 to 100, with the top band closed at 100. `gradeFor` is the only way a score becomes a letter.

## Consequences
The UI shows "components + exam = total" live and states by how much a scheme is off. The form and API never accept floats for marks.

## Enforced by
`tests/unit/scoring-rules.spec.ts` (15) and `tests/integration/academic-scoring.spec.ts`. Mutation targets (sum rule, band contiguity) are in the plan.

## Related
Open question for the maintainer: whole-number-only bands? (`handoff/phase-1-slice-1.md` §7.4).
