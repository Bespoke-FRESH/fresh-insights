#!/usr/bin/env pwsh
# merge_gate.ps1 -- local pre-merge gate for FRESH repos. Exit 0 = mechanical
# checks clear; the reviewer + scientific verifier are agent-driven steps the
# AGENT_MERGE_PROTOCOL.md requires AROUND this script. This does what a script
# can: clean tree, non-stale branch, green harness, no secrets/binaries in diff.
# ASCII-only on purpose (runs under Windows PowerShell 5.1, which reads .ps1 as ANSI).
#
#   powershell -ExecutionPolicy Bypass -File scripts/merge_gate.ps1   # auto-detect base
#   powershell -ExecutionPolicy Bypass -File scripts/merge_gate.ps1 -Base main
param([string]$Base = "")

function Fail($m) { Write-Host "GATE FAIL: $m" -ForegroundColor Red; exit 1 }
function Ok($m)   { Write-Host "  ok: $m"       -ForegroundColor Green }

# --- resolve base branch ---
if (-not $Base) {
  foreach ($b in @("main", "master")) {
    git rev-parse --verify --quiet $b > $null 2>&1
    if ($LASTEXITCODE -eq 0) { $Base = $b; break }
  }
}
if (-not $Base) { Fail "could not resolve a base branch. Pass -Base <name>." }

$head = (git rev-parse --abbrev-ref HEAD).Trim()
if ($head -eq $Base) { Fail "you are on the base branch ($Base). Work on a feature branch." }

# --- 1. clean working tree ---
if (git status --porcelain) { Fail "working tree not clean -- commit or stash first" }
Ok "working tree clean"

# --- 2. branch not stale vs base (conflicting-tree guard) ---
git fetch origin $Base --quiet 2>$null
$ref = "origin/$Base"
git rev-parse --verify --quiet $ref > $null 2>&1
if ($LASTEXITCODE -ne 0) { $ref = $Base }
$behind = (git rev-list --count "HEAD..$ref" 2>$null)
if (-not $behind) { $behind = 0 }
if ([int]$behind -gt 0) { Fail "branch is $behind commit(s) behind $ref -- rebase before merging" }
Ok "branch current with $ref"

# --- 3. test harness (where one exists) ---
if (Test-Path "tests/run_all.R") {
  Write-Host "  running tests/run_all.R ..."
  Rscript "tests/run_all.R"
  if ($LASTEXITCODE -ne 0) { Fail "test harness red (tests/run_all.R)" }
  Ok "test harness green"
} elseif (Test-Path "scripts/verify_hub.sh") {
  Write-Host "  running scripts/verify_hub.sh --ci ..."
  bash "scripts/verify_hub.sh" --ci
  if ($LASTEXITCODE -ne 0) { Fail "acceptance harness red (verify_hub.sh)" }
  Ok "acceptance harness green"
} else {
  Write-Host "  note: no known test harness in this repo -- none run" -ForegroundColor Yellow
}

# --- 4. secret / large-binary scan on the diff vs base ---
$diff = (git diff --name-only "$ref...HEAD") -split "`n" | Where-Object { $_ }
$secret = $diff | Where-Object { $_ -match '(^|/)(\.Renviron|\.env|Secrets\.R)$|\.(key|pem)$' }
if ($secret) { Fail "sensitive file in diff: $($secret -join ', ')" }
$big = $diff | Where-Object { (Test-Path $_) -and ((Get-Item $_).Length -gt 5MB) }
if ($big) { Fail "large file (>5MB) in diff: $($big -join ', ')" }
Ok "no secrets or large binaries in diff"

Write-Host ""
Write-Host "GATE PASS (mechanical). Now, per AGENT_MERGE_PROTOCOL.md: run /code-review," -ForegroundColor Cyan
Write-Host "run the change-class verifier (section 5), write the evidence packet, then merge." -ForegroundColor Cyan
exit 0
