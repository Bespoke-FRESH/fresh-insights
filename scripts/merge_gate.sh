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

# --- native-command helpers ------------------------------------------------
# Unlike the PowerShell gate (where a missing command leaves $LASTEXITCODE stale
# and produces a FALSE GREEN), bash reports 127 for a missing command, so the
# `cmd || fail` form is already safe here. It is still wrong in its message: it
# blames the harness for what is really a missing interpreter. Resolve the
# interpreter explicitly and say which of the two actually happened.
run_checked() {                       # run_checked <what> <exe> [args...]
  local what="$1" exe="$2"; shift 2
  # accept either an absolute path or a bare name resolvable on PATH
  command -v "$exe" >/dev/null 2>&1 || [ -f "$exe" ] || fail "$what -- interpreter not found: '$exe'"
  "$exe" "$@"
  local code=$?
  [ "$code" -eq 0 ] || fail "$what red (exit $code)"
}

# Resolve an R interpreter without assuming PATH. Order: $RSCRIPT override,
# PATH, then the standard Windows install root (highest version wins).
resolve_rscript() {
  if [ -n "${RSCRIPT:-}" ] && [ -f "$RSCRIPT" ]; then printf '%s' "$RSCRIPT"; return 0; fi
  if command -v Rscript >/dev/null 2>&1; then command -v Rscript; return 0; fi
  local best="" root p ver roots
  roots=("/c/Program Files/R" "/c/Program Files (x86)/R" "${LOCALAPPDATA:-}/Programs/R")
  [ -n "${FRESH_R_ROOT:-}" ] && roots=("$FRESH_R_ROOT")   # test hook
  for root in "${roots[@]}"; do
    [ -d "$root" ] || continue
    for p in "$root"/R-*/bin/Rscript.exe "$root"/R-*/bin/x64/Rscript.exe; do
      [ -f "$p" ] || continue
      ver="$(printf '%s' "$p" | sed -n 's|.*/R-\([0-9][0-9.]*\)/.*|\1|p')"
      [ -n "$ver" ] || continue
      # rank: prefer bin/ over bin/x64/ so a version tie resolves the same way
      # the PowerShell gate resolves it. sort -V ascending + tail -1 => highest
      # version, then highest rank.
      case "$p" in *"/bin/x64/"*) rank=0 ;; *) rank=1 ;; esac
      printf '%s\t%s\t%s\n' "$ver" "$rank" "$p"
    done
  done | sort -V | tail -n 1 | cut -f3- | { read -r best || true; printf '%s' "$best"; }
}

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
# A gate that CANNOT run the harness must fail. Silence is not green.
if [ -f tests/run_all.R ]; then
  RSCRIPT_BIN="$(resolve_rscript)"
  [ -n "$RSCRIPT_BIN" ] || fail "tests/run_all.R exists but no R interpreter was found (PATH, \$RSCRIPT, or 'C:\\Program Files\\R\\R-*\\bin\\Rscript.exe'). Cannot verify the harness -- refusing to pass."
  echo "  running tests/run_all.R via $RSCRIPT_BIN ..."
  run_checked "test harness (tests/run_all.R)" "$RSCRIPT_BIN" tests/run_all.R
  ok "test harness green"
elif [ -f scripts/verify_hub.sh ]; then
  BASH_BIN="${BASH:-bash}"
  command -v "$BASH_BIN" >/dev/null 2>&1 || [ -f "$BASH_BIN" ] || fail "scripts/verify_hub.sh exists but no bash interpreter was found. Cannot verify the harness -- refusing to pass."
  echo "  running scripts/verify_hub.sh --ci via $BASH_BIN ..."
  run_checked "acceptance harness (verify_hub.sh)" "$BASH_BIN" scripts/verify_hub.sh --ci
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
