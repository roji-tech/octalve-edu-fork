# 0011 — Development happens on `dev`; `master` needs the maintainer's approval; `prod` is reserved
Status: accepted · Decided: by the maintainer · Recorded: 2026-10-08

## Context
The AI pushed feature branches to the fork and the maintainer merged everything; octalve-core was read-only to the AI. That made each step wait on a human.

## Decision
- **octalve-core (`origin`) is writable and is where development happens from now on.** Its fork (`roji-tech/octalve-edu-fork`) receives octalve-core by merge **after Phase 3**, not before; until then the fork is a mirror, and existing PRs on it (#10, 1.2) are retargeted or ported to octalve-core.
- octalve-core and the fork each have `dev` (all development), `master`, and a future `prod`.
- The AI may push feature branches, open PRs and **merge into `dev`** once the gate (typecheck → lint → format:check → build → tests) has passed, with the evidence in the PR.
- A PR `dev` → `master` is merged only after the maintainer approves **that specific PR** in the session; stacked PRs merge in order. Nobody pushes straight to `master` or `prod`; `prod` is untouched until its flow is defined. A blocked merge is reported, never worked around.

## Consequences
Branches `dev`/`prod` must be created on both remotes; open PRs need retargeting.

## Enforced by
Convention and permission checks; branch protection on `master`/`prod` is recommended.

## Related
0007 · 0012 · 0013.
