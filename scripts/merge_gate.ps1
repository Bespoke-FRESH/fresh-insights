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

# --- native-command helpers ------------------------------------------------
# PowerShell does NOT touch $LASTEXITCODE when a command cannot be resolved: it
# raises CommandNotFoundException and the variable keeps the exit code of the
# PREVIOUS native command. So the naive form
#     SomeTool args
#     if ($LASTEXITCODE -ne 0) { Fail "..." }
# reports a FALSE GREEN whenever SomeTool is missing and the last native command
# happened to succeed (here: the git rev-list in section 2). Every native
# invocation in this gate must go through Invoke-Checked, which resolves the
# executable up front, clears $LASTEXITCODE, and treats a null/empty code after
# the call as a failure rather than a pass.
#
# Invoke-Checked deliberately returns nothing and fails in-place: a native
# command's stdout lands in the function's output stream, so returning an exit
# code would hand the caller @("...output...", 0) instead of 0.
function Invoke-Checked {
  param(
    [Parameter(Mandatory=$true)][string]$Exe,
    [string[]]$CmdArgs = @(),
    [Parameter(Mandatory=$true)][string]$What
  )
  if (-not (Test-Path -LiteralPath $Exe)) { Fail "$What -- interpreter not found at '$Exe'" }
  $global:LASTEXITCODE = $null
  & $Exe @CmdArgs | Out-Host
  $code = $LASTEXITCODE
  if ($null -eq $code -or "$code" -eq "") {
    Fail "$What -- '$Exe' never ran (no exit code reported). Refusing to pass on a stale exit code."
  }
  if ([int]$code -ne 0) { Fail "$What red (exit $code)" }
}

# Resolve an R interpreter without assuming PATH. Order: $env:RSCRIPT override,
# PATH, then the standard Windows install root (highest version wins).
function Resolve-Rscript {
  if ($env:RSCRIPT -and (Test-Path -LiteralPath $env:RSCRIPT)) { return $env:RSCRIPT }
  $onPath = Get-Command Rscript -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
  if ($onPath) { return $onPath.Source }
  $roots = @("$env:ProgramFiles\R", "${env:ProgramFiles(x86)}\R", "$env:LOCALAPPDATA\Programs\R")
  if ($env:FRESH_R_ROOT) { $roots = @($env:FRESH_R_ROOT) }   # test hook
  $globs = @()
  foreach ($r in $roots) { if ($r) { $globs += "$r\R-*\bin\Rscript.exe", "$r\R-*\bin\x64\Rscript.exe" } }
  $found = Get-ChildItem -Path $globs -ErrorAction SilentlyContinue
  # Sort by real version (so R-4.10 beats R-4.9), then prefer bin\ over bin\x64\
  # so the choice is deterministic when both exist for the same version.
  $best = $found |
    ForEach-Object {
      if ($_.FullName -match '\\R-(\d+(?:\.\d+)*)\\') {
        [pscustomobject]@{
          Path    = $_.FullName
          Version = [version]$Matches[1]
          Rank    = if ($_.FullName -match '\\bin\\x64\\') { 1 } else { 0 }
        }
      }
    } | Sort-Object @{E='Version';Descending=$true}, @{E='Rank';Descending=$false} |
    Select-Object -First 1
  if ($best) { return $best.Path }
  return $null
}

# Same idea for bash (Git for Windows ships one even when it is off PATH).
function Resolve-Bash {
  if ($env:BASH_EXE -and (Test-Path -LiteralPath $env:BASH_EXE)) { return $env:BASH_EXE }
  $onPath = Get-Command bash -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
  if ($onPath) { return $onPath.Source }
  foreach ($c in @("$env:ProgramFiles\Git\bin\bash.exe",
                   "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
                   "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe")) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

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
# A gate that CANNOT run the harness must fail. Silence is not green.
if (Test-Path "tests/run_all.R") {
  $rscript = Resolve-Rscript
  if (-not $rscript) {
    Fail "tests/run_all.R exists but no R interpreter was found (PATH, `$env:RSCRIPT, or 'C:\Program Files\R\R-*\bin\Rscript.exe'). Cannot verify the harness -- refusing to pass."
  }
  Write-Host "  running tests/run_all.R via $rscript ..."
  Invoke-Checked -Exe $rscript -CmdArgs @("tests/run_all.R") -What "test harness (tests/run_all.R)"
  Ok "test harness green"
} elseif (Test-Path "scripts/verify_hub.sh") {
  $bashExe = Resolve-Bash
  if (-not $bashExe) {
    Fail "scripts/verify_hub.sh exists but no bash interpreter was found (PATH, `$env:BASH_EXE, or the Git for Windows install). Cannot verify the harness -- refusing to pass."
  }
  Write-Host "  running scripts/verify_hub.sh --ci via $bashExe ..."
  Invoke-Checked -Exe $bashExe -CmdArgs @("scripts/verify_hub.sh", "--ci") -What "acceptance harness (verify_hub.sh)"
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
