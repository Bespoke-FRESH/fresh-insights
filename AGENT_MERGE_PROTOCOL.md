# Agent Merge Protocol (FRESH)

Applies to any coding agent (Claude Code, Codex, etc.) working in this repo. The
goal is that agents commit, PR, and merge their own work **without Josh reviewing
every diff** — while stopping hard at the boundaries where his judgment is
actually required. Read this before you start; it is the local substitute for
GitHub branch protection (these are private repos on a plan without it).

## 1. Before you start — write the task down
State, in the task note or the PR body:
- **Problem** — what is wrong or missing, as observable behavior (not "change function X").
- **Desired behavior** — what should happen instead.
- **Acceptance criteria** — the evidence that would prove success. Must be testable.
- **Constraints / non-goals** — what must NOT change.
- **Risk class** — A, B, or C (see §3).

Then read this file, `AGENTS.md`/`CLAUDE.md`, and the code around your change
before editing.

## 2. While you work — leave no mess
- One branch or worktree per task, started from a clean, current base.
- One PR, one purpose. Unrelated cleanup goes in a separate PR.
- New or changed behavior gets a test that can **fail** when the behavior is wrong.
- **Never `git add -A` in this workspace.** Stage by explicit path. (Several repos
  keep large regenerable artifacts untracked-on-purpose; a blanket add bloats
  history permanently.) No secrets, generated DBs, or large binaries staged.
- **Close your ledger entry in the same PR that does the work.** If you opened a
  `docs/agent_control/` status/ledger entry or a `NEXT_STEPS.md` item, mark it
  done or delete it here — do not leave open ledger files behind.
- **Remove your worktree when done** (`git worktree remove <path>`). Do not leave
  orphaned or detached-HEAD trees behind.

## 3. Risk class — who gets to merge
**Class A / B → the agent may self-merge** once the gate (§4) is green: docs,
tests, logging, localized bug fixes with a reproduction, internal refactors with
unchanged interfaces, UI changes covered by screenshots, and data / schema /
pipeline changes **that pass the §5 specialized checks**.

**Class C → stop and ask Josh.** These are semantic boundaries no test can
adjudicate:
- Changing a **statistical estimand**, reference population, weighting, or units.
- Changing what an **NPS / classification score means** (expert-rule vs
  data-driven; outcome-specific vs general).
- Anything touching the **patent boundary** — that material is internal-only and
  must never surface in public-facing output.
- **Novelty claims** in any paper/post (e.g. the JANA carb paper's new
  contribution is consumer belief-elicitation + misperception; meta-NPS and
  expert uncertainty were prior work — do not overclaim "first to…").
- **Licensing / data-use** (e.g. ODbL attribution on composition data, ToS of a
  scraped source).
- **Privacy / retention** of any person-level or corpus data.
- Accepting a known reduction in correctness, or changing externally-promised behavior.

For Class C: isolate the exact decision, present the options and their
consequences, keep doing all the non-ambiguous work, and let Josh decide only
that one point.

## 4. The gate — run before you merge
Run `scripts/merge_gate.ps1` (or `scripts/merge_gate.sh`). It refuses unless:
- the working tree is clean and the branch is rebased on a current base (no stale
  or conflicting tree),
- the test harness passes (where one exists),
- no secrets or large binaries are in the diff.

Then, by hand, before merging:
- Run an **independent review agent** (`/code-review`) and resolve every blocking finding.
- Run the **change-class verifier** for what you touched (§5).
- Write the **evidence packet** (§6) into the PR body.

Only then: `gh pr create` → `gh pr merge --squash`. A green gate is necessary, not
sufficient, and the **final** commit — not an earlier one — must pass.

## 5. Specialized verification — keep the ones that apply
- **Scientific / statistical code:** estimand unchanged unless authorized; units and
  reference population explicit; result compared to a known benchmark with a defined
  numerical tolerance; missing-data and boundary behavior tested. For usual-intake /
  adequacy work, the `nci-usualintake-validate` skill **is** this step.
- **Data pipelines:** input/output schema validated; record counts compared; dropped
  or duplicate records explained; provenance retained; re-run idempotent (or
  intentionally not).
- **DB / schema migrations:** tested on a copy of realistic data; forward + rollback
  tested; row counts, null rates, uniqueness, and FKs checked.
- **UI (Shiny):** critical flow exercised; empty / loading / success / failure states
  checked; console clean; the UI never shows success before the backend confirms it.
  Use the fresh-ux verify loop.

## 6. Evidence packet — in the PR body
- What changed, why, and what you deliberately left alone.
- Each acceptance criterion paired with the evidence for it.
- Commands run and their results (tests, verifier); disclose skips and warnings.
- Before / after for behavior changes (rows, API response, screenshot, numbers).
- Risk class + the rollback / repair method.

Do not certify with "looks correct", "should work", or "small change, didn't
test". Every correctness claim needs executable or observable evidence.

---
*This protocol is enforced locally, not by GitHub. The reviewer and the verifier
are agent-driven steps you must run around the mechanical `merge_gate` script —
the script checks what a script can; you are accountable for the rest.*
