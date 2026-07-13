#!/usr/bin/env bash
# merge_gate.sh -- local pre-merge gate for FRESH repos. Exit 0 = mechanical
# checks clear; the reviewer + scientific verifier are agent-driven steps the
# AGENT_MERGE_PROTOCOL.md requires AROUND this script. This does what a script
# can: clean tree, non-stale branch, green harness, no secrets/binaries in diff.
#
#   bash scripts/merge_gate.sh          # auto-detect base (main/master)
#   bash scripts/merge_gate.sh main
set -u
BASE="${1:-}"
fail() { printf 'GATE FAIL: %s\n' "$1" >&2; exit 1; }
ok()   { printf '  ok: %s\n' "$1"; }

# --- resolve base branch ---
if [ -z "$BASE" ]; then
  for b in main master; do
    if git rev-parse --verify --quiet "$b" >/dev/null 2>&1; then BASE="$b"; break; fi
  done
fi
[ -n "$BASE" ] || fail "could not resolve a base branch. Pass it as the first arg."

HEAD="$(git rev-parse --abbrev-ref HEAD)"
[ "$HEAD" != "$BASE" ] || fail "you are on the base branch ($BASE). Work on a feature branch."

# --- 1. clean working tree ---
[ -z "$(git status --porcelain)" ] || fail "working tree not clean -- commit or stash first"
ok "working tree clean"

# --- 2. branch not stale vs base (conflicting-tree guard) ---
git fetch origin "$BASE" --quiet 2>/dev/null || true
REF="origin/$BASE"
git rev-parse --verify --quiet "$REF" >/dev/null 2>&1 || REF="$BASE"
BEHIND="$(git rev-list --count "HEAD..$REF" 2>/dev/null || echo 0)"
[ "${BEHIND:-0}" -eq 0 ] || fail "branch is $BEHIND commit(s) behind $REF -- rebase before merging"
ok "branch current with $REF"

# --- 3. test harness (where one exists) ---
if [ -f tests/run_all.R ]; then
  echo "  running tests/run_all.R ..."
  Rscript tests/run_all.R || fail "test harness red (tests/run_all.R)"
  ok "test harness green"
elif [ -f scripts/verify_hub.sh ]; then
  echo "  running scripts/verify_hub.sh --ci ..."
  bash scripts/verify_hub.sh --ci || fail "acceptance harness red (verify_hub.sh)"
  ok "acceptance harness green"
else
  echo "  note: no known test harness in this repo -- none run"
fi

# --- 4. secret / large-binary scan on the diff vs base ---
DIFF="$(git diff --name-only "$REF...HEAD")"
if echo "$DIFF" | grep -Eq '(^|/)(\.Renviron|\.env|Secrets\.R)$|\.(key|pem)$'; then
  fail "sensitive file in diff: $(echo "$DIFF" | grep -E '(^|/)(\.Renviron|\.env|Secrets\.R)$|\.(key|pem)$' | tr '\n' ' ')"
fi
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  sz=$(wc -c < "$f" 2>/dev/null || echo 0)
  [ "$sz" -le 5242880 ] || fail "large file (>5MB) in diff: $f"
done <<< "$DIFF"
ok "no secrets or large binaries in diff"

echo
echo "GATE PASS (mechanical). Now, per AGENT_MERGE_PROTOCOL.md: run /code-review,"
echo "run the change-class verifier (section 5), write the evidence packet, then merge."
exit 0
