# 0012 — The docker databases are local development databases with full access
Status: accepted · Decided: by the maintainer · Recorded: 2026-10-08

## Context
Octalve's dev database (`octalve_edu`, :5433) was already the AI's to migrate. The AlEemaan sibling's docker database (:5434) was off-limits as "live"; the maintainer says it is local too.

## Decision
The AI has full access to both docker databases (migrate, reset, use for dev). Tests use their `*_test` databases and roles as before.

## Consequences
Easier dev loops. Production data, wherever it lives, is not these databases.

## Enforced by
The test harness's database-name checks.

## Related
0011.
