param(
  [string]$Workspace = "$env:USERPROFILE\Documents\DreamStream-Toonflow-V0.1"
)

$ErrorActionPreference = "Stop"

$AppRepo = Join-Path $Workspace "dreamstream-toonflow"
$WebRepo = Join-Path $Workspace "dreamstream-toonflow-web"
$TestUserData = Join-Path $Workspace "test-userdata"

if (-not (Test-Path $AppRepo)) { throw "App repository not found. Run prepare-test first." }
if (-not (Test-Path $WebRepo)) { throw "Web repository not found. Run prepare-test first." }
if (-not (Test-Path (Join-Path $TestUserData "data\db2.sqlite"))) { throw "Isolated test data not found. Run prepare-test first." }
if (-not (Test-Path (Join-Path $AppRepo "node_modules"))) { throw "App node_modules missing. Run prepare-test first." }
if (-not (Test-Path (Join-Path $WebRepo "node_modules"))) { throw "Web node_modules missing. Run prepare-test first." }

Write-Host "Starting Dream Stream Toonflow Web (Vite :50188)..." -ForegroundColor Cyan
$webCommand = "Set-Location -LiteralPath '$WebRepo'; npx.cmd -y yarn@1.22.22 dev"
Start-Process powershell.exe -ArgumentList "-NoExit", "-NoProfile", "-Command", $webCommand | Out-Null

$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", 50188, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne(500)) {
      $client.EndConnect($async)
      $client.Close()
      $ready = $true
      break
    }
    $client.Close()
  } catch {}
  Start-Sleep -Seconds 1
}

if (-not $ready) {
  throw "Vite did not become ready on port 50188 within 90 seconds."
}

Write-Host "Starting isolated Dream Stream Toonflow Electron test app..." -ForegroundColor Cyan
$appCommand = "`$env:TOONFLOW_DEV_USER_DATA='$TestUserData'; Set-Location -LiteralPath '$AppRepo'; npx.cmd -y yarn@1.22.22 dev:gui-vite"
Start-Process powershell.exe -ArgumentList "-NoExit", "-NoProfile", "-Command", $appCommand | Out-Null

Write-Host ""
Write-Host "Dream Stream Toonflow V0.1 is starting." -ForegroundColor Green
Write-Host "The original Toonflow data folder is NOT used directly." -ForegroundColor Green
Write-Host "Test userData: $TestUserData"
Write-Host "Close the Electron window and the two PowerShell windows to stop the test environment."
