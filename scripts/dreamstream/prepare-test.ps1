param(
  [string]$Workspace = "$env:USERPROFILE\Documents\DreamStream-Toonflow-V0.1",
  [string]$SourceData = "$env:APPDATA\toonflow\data",
  [switch]$RefreshData
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Assert-NodeVersion {
  $raw = (& node --version).Trim().TrimStart("v")
  $v = [version]$raw
  $minimum = [version]"22.12.0"
  if ($v -lt $minimum) {
    throw "Node.js $minimum or newer is required. Current: $v"
  }
  Write-Host "Node.js $v"
}

function Sync-Repo([string]$Url, [string]$Path, [string]$Branch) {
  if (-not (Test-Path $Path)) {
    Write-Step "Cloning $Url"
    & git clone --branch $Branch --single-branch $Url $Path
    if ($LASTEXITCODE -ne 0) { throw "git clone failed: $Url" }
    return
  }

  Write-Step "Updating $(Split-Path $Path -Leaf)"
  Push-Location $Path
  try {
    $dirty = (& git status --porcelain)
    if ($dirty) {
      throw "Repository has local changes: $Path. Commit/stash them before continuing."
    }
    & git fetch origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $Path" }
    & git checkout $Branch
    if ($LASTEXITCODE -ne 0) { throw "git checkout failed: $Path" }
    & git pull --ff-only origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git pull failed: $Path" }
  } finally {
    Pop-Location
  }
}

function Install-Repo([string]$Path) {
  Write-Step "Installing dependencies: $(Split-Path $Path -Leaf)"
  Push-Location $Path
  try {
    & npx.cmd -y yarn@1.22.22 install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
      throw "Dependency installation failed in $Path"
    }
  } finally {
    Pop-Location
  }
}

Require-Command git
Require-Command node
Require-Command npm
Require-Command npx.cmd
Assert-NodeVersion

$AppRepo = Join-Path $Workspace "dreamstream-toonflow"
$WebRepo = Join-Path $Workspace "dreamstream-toonflow-web"
$TestUserData = Join-Path $Workspace "test-userdata"
$TestData = Join-Path $TestUserData "data"

New-Item -ItemType Directory -Force -Path $Workspace | Out-Null

Sync-Repo "https://github.com/waynezhu089-wq/dreamstream-toonflow.git" $AppRepo "dreamstream/general-video-v0.1"
Sync-Repo "https://github.com/waynezhu089-wq/dreamstream-toonflow-web.git" $WebRepo "dreamstream/general-video-v0.1"

Install-Repo $AppRepo
Install-Repo $WebRepo

if ($RefreshData -or -not (Test-Path (Join-Path $TestData "db2.sqlite"))) {
  if (-not (Test-Path $SourceData)) {
    throw "Original Toonflow data folder not found: $SourceData"
  }

  Write-Step "Creating isolated test data copy"
  if (Test-Path $TestData) {
    Remove-Item -Recurse -Force $TestData
  }
  New-Item -ItemType Directory -Force -Path $TestData | Out-Null

  & robocopy $SourceData $TestData /E /COPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
  $robocopyCode = $LASTEXITCODE
  if ($robocopyCode -gt 7) {
    throw "robocopy failed with exit code $robocopyCode"
  }
}

Write-Step "Overlaying Dream Stream advertisement skills into isolated test data"
$ProfileSource = Join-Path $AppRepo "data\skills\profiles\advertisement"
$ProfileTarget = Join-Path $TestData "skills\profiles\advertisement"
if (-not (Test-Path $ProfileSource)) {
  throw "Advertisement profile skills missing from app repository: $ProfileSource"
}
New-Item -ItemType Directory -Force -Path $ProfileTarget | Out-Null
Copy-Item -Path (Join-Path $ProfileSource "*") -Destination $ProfileTarget -Recurse -Force

$Marker = @"
Dream Stream Toonflow V0.1 local test workspace
Created: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
App repo: $AppRepo
Web repo: $WebRepo
Isolated userData: $TestUserData
Original data source (copied only): $SourceData
"@
Set-Content -Path (Join-Path $Workspace "TEST_WORKSPACE.txt") -Value $Marker -Encoding UTF8

Write-Step "Preparation complete"
Write-Host "Workspace: $Workspace" -ForegroundColor Green
Write-Host "Test data: $TestData" -ForegroundColor Green
Write-Host ""
Write-Host "Next: run scripts\dreamstream\start-test.cmd from the app repository, or use the Start shortcut described in the local test guide."
