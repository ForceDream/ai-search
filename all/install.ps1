














[CmdletBinding()]
param(
    [switch]$Test,
    [switch]$Full,
    [switch]$NoJs,
    [switch]$Skill,
    [switch]$SkillUser
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Split-Path -Parent $Here

$Py = if ($env:PYTHON) { $env:PYTHON } else { $null }
if (-not $Py) {
    foreach ($cand in @("python", "py")) {
        if (Get-Command $cand -ErrorAction SilentlyContinue) { $Py = $cand; break }
    }
}
if (-not $Py) {
    Write-Error "Python not found. Install Python >= 3.9 first (https://www.python.org/downloads/)."
    exit 1
}

if ($env:VENV -eq "1" -and -not (Test-Path (Join-Path $Repo ".venv"))) {
    Write-Host "== creating .venv =="
    & $Py -m venv (Join-Path $Repo ".venv")
    $Py = Join-Path $Repo ".venv\Scripts\python.exe"
}

Write-Host "== platform: Windows | Python: $(& $Py --version 2>&1) =="

$extras = @()
if ($Test) { $extras += "test" }
if ($Full) { $extras += "full" }
$target = if ($extras.Count -gt 0) { "$Repo[" + ($extras -join ",") + "]" } else { $Repo }

Write-Host "== installing aisearch (Python) =="
& $Py -m pip install -e $target
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $NoJs) {
    Write-Host "== checking Node port =="
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Host ("node " + (node --version) + " found (aisearch-js has zero npm deps).")
        Write-Host ("Optional global command: cd `"$Repo\aisearch-js`"; npm link")
    } else {
        Write-Host "node not found - skipping; the Node port requires Node >= 18."
        Write-Host "  install: winget install OpenJS.NodeJS.LTS"
    }
}

Write-Host ""
if ($Skill -or $SkillUser) {
    Write-Host "== installing CodeBuddy skill =="
    Write-Host "  Deprecated: the skill form now lives on this repo's 'skill' branch"
    Write-Host "  (git checkout skill). See README and the branch's SKILL.md."
    Write-Host ""
}

Write-Host "Done."
Write-Host "  aisearch --version                                    # Python CLI"
Write-Host "  aisearch rpc                                          # stdio mode for AI harnesses"
Write-Host "  node `"$Repo\aisearch-js\bin\aisearch.mjs`" --help    # Node CLI (without npm link)"
Write-Host "  For CodeBuddy/VibeCode skill: .\all\install.ps1 -Skill   (or -SkillUser)"
