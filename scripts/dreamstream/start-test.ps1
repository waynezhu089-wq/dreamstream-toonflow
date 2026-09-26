param(
  [string]$Workspace = "$env:USERPROFILE\Documents\DreamStream-Toonflow-V0.1"
)

$ErrorActionPreference = "Stop"

$AppRepo = Join-Path $Workspace "dreamstream-toonflow"
$WebRepo = Join-Path $Workspace "dreamstream-toonflow-web"
$TestUserData = Join-Path $Workspace "test-userdata"
$TestData = Join-Path $TestUserData "data"

if (-not (Test-Path $AppRepo)) { throw "App repository not found. Run prepare-test first." }
if (-not (Test-Path $WebRepo)) { throw "Web repository not found. Run prepare-test first." }
if (-not (Test-Path (Join-Path $TestData "db2.sqlite"))) { throw "Isolated test data not found. Run prepare-test first." }
if (-not (Test-Path (Join-Path $AppRepo "node_modules"))) { throw "App node_modules missing. Run prepare-test first." }
if (-not (Test-Path (Join-Path $WebRepo "node_modules"))) { throw "Web node_modules missing. Run prepare-test first." }

function Wait-Port([int]$Port, [int]$Seconds = 90) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
      if ($async.AsyncWaitHandle.WaitOne(500)) {
        $client.EndConnect($async)
        $client.Close()
        return $true
      }
      $client.Close()
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

Write-Host "Starting isolated Dream Stream Toonflow backend (:10588)..." -ForegroundColor Cyan
$backendCommand = "`$env:TOONFLOW_DATA_DIR='$TestData'; Set-Location -LiteralPath '$AppRepo'; npx.cmd -y yarn@1.22.22 dev"
Start-Process powershell.exe -ArgumentList "-NoExit", "-NoProfile", "-Command", $backendCommand | Out-Null

if (-not (Wait-Port 10588 90)) {
  throw "Backend did not become ready on port 10588 within 90 seconds."
}

Write-Host "Starting Dream Stream Toonflow Web (:50188)..." -ForegroundColor Cyan
$webCommand = "Set-Location -LiteralPath '$WebRepo'; npx.cmd -y yarn@1.22.22 dev"
Start-Process powershell.exe -ArgumentList "-NoExit", "-NoProfile", "-Command", $webCommand | Out-Null

if (-not (Wait-Port 50188 90)) {
  throw "Vite did not become ready on port 50188 within 90 seconds."
}

Write-Host ""
Write-Host "Dream Stream Toonflow V0.1 browser test is ready." -ForegroundColor Green
Write-Host "Backend: http://127.0.0.1:10588" -ForegroundColor Green
Write-Host "Web:     http://127.0.0.1:50188" -ForegroundColor Green
Write-Host "Test data: $TestData"
Write-Host "The original Toonflow data folder is NOT used directly."
Write-Host ""

Start-Process "http://127.0.0.1:50188"

Write-Host "Close the two PowerShell windows to stop the test environment."
