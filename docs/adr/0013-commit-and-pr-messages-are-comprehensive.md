# 0013 — Commit and PR messages are comprehensive
Status: accepted · Decided: by the maintainer · Recorded: 2026-10-08

## Context
Short messages lose the reasoning, deviations and test evidence the next person or AI needs.

## Decision
A commit has a clear subject and a body: what and why, design decisions and deviations, bugs found and fixed, migrations, and exactly which tests and gates ran with results (and what did not). A PR adds a summary by area, risk spots, migration notes, test evidence with counts, what was not done, open questions and how to verify.

## Consequences
Longer messages; docs-only commits get a body too.

## Enforced by
Review.

## Related
0011.
