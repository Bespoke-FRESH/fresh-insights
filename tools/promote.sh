#!/usr/bin/env bash
# promote.sh — the deliberate "go live" action for a FRESH Insights draft.
#
# A draft in _drafts/<slug>/ is structurally OFF the deploy path (Quarto ignores
# _-prefixed folders). Promotion moves it to the repo root, where the index
# listing picks it up and the next push to main renders it live. This is the ONE
# place "written" becomes "published" — kept a separate, human act on purpose.
#
# It stages the move but does NOT commit or push: going live stays a deliberate
# two-step (promote, then review + push), never automatic.
#
#   tools/promote.sh <slug>
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

slug="${1:-}"
if [[ -z "$slug" ]]; then
  echo "usage: tools/promote.sh <slug>"
  echo "drafts available:"; ls -1 _drafts 2>/dev/null | grep -v '^README' || echo "  (none)"
  exit 2
fi
slug="${slug#_drafts/}"; slug="${slug%/}"   # tolerate _drafts/<slug> or <slug>/

[[ -d "_drafts/$slug" ]] || { echo "✗ no draft at _drafts/$slug"; exit 1; }
[[ ! -e "$slug" ]]       || { echo "✗ '$slug' already exists at the repo root (already live?)"; exit 1; }
[[ -f "_drafts/$slug/index.qmd" ]] || { echo "✗ _drafts/$slug has no index.qmd"; exit 1; }

echo "Promoting _drafts/$slug → $slug (staging the git move; NOT committing)"
git mv "_drafts/$slug" "$slug"

echo "✓ Staged. It is NOT live yet — the deploy runs on your push to main."
echo
echo "Before you push:"
echo "  1. Preview it once more:  quarto render $slug/index.qmd  &&  open $slug/index.html"
echo "  2. Confirm the sensitivity + citation checks passed (fresh-weekly-essay Step 6)."
if [[ -d "_social/$slug" ]]; then
  echo "  3. LinkedIn derivative is at _social/$slug/ — post it after the site is live."
fi
echo
echo "Then go live (deliberately):"
echo "  git commit -m \"publish: $slug\""
echo "  git push          # ← this, and only this, deploys it to insights.freshfoodrecs.com"
