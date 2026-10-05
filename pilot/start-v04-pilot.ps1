param([int]$OwnerUserId = 0)

$ErrorActionPreference = 'Stop'
$experimentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backendRoot = Join-Path $experimentRoot 'backend'
$frontendRoot = Join-Path $experimentRoot 'frontend'
$dataDir = Join-Path $experimentRoot 'userdata\pilot\data'
$logDir = Join-Path $experimentRoot 'logs'
if (-not (Test-Path -LiteralPath $backendRoot -PathType Container) -or -not (Test-Path -LiteralPath $frontendRoot -PathType Container)) {
  throw 'V0.4 experimental backend/frontend checkouts are required side by side.'
}
New-Item -ItemType Directory -Path $dataDir,$logDir -Force | Out-Null
$dbPath = Join-Path $dataDir 'db2.sqlite'
function Test-LocalPort([int]$port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $attempt = $client.ConnectAsync('127.0.0.1', $port)
    return $attempt.Wait(400) -and $client.Connected
  } catch { return $false }
  finally { $client.Dispose() }
}
$backendRunning = Test-LocalPort 10589
$frontendRunning = Test-LocalPort 50189
if (Test-Path -LiteralPath $dbPath -PathType Leaf) {
  $env:V04_OWNER_DB_PATH = $dbPath
  Push-Location $backendRoot
  try {
    $existingOwner = & node (Join-Path $PSScriptRoot 'read-owner.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the disposable pilot owner account.' }
  } finally { Pop-Location }
  if ($OwnerUserId -gt 0 -and "$OwnerUserId" -ne "$existingOwner") { throw 'The supplied Studio owner does not match the sole account in this disposable pilot database.' }
  if ($OwnerUserId -eq 0 -and $existingOwner) { $OwnerUserId = [int]$existingOwner }
}

$env:NODE_ENV = 'prod'
$env:DS_V04_PILOT = '1'
$env:TOONFLOW_DATA_DIR = $dataDir
$env:DS_PORT = '10589'
$env:DS_STUDIO_OWNER_USER_ID = if ($OwnerUserId -gt 0) { [string]$OwnerUserId } else { '' }
$env:DS_REVISION_CONFIRM_ENABLED = if ($OwnerUserId -gt 0) { 'true' } else { 'false' }
$backend = if (-not $backendRunning) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c','node_modules\.bin\tsx.cmd src\app.ts' -WorkingDirectory $backendRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') -RedirectStandardError (Join-Path $logDir 'backend.err.log') -PassThru } else { $null }
$frontend = if (-not $frontendRunning) { Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c','node_modules\.bin\vite.cmd --config vite.config.ts --host 127.0.0.1 --port 50189 --strictPort' -WorkingDirectory $frontendRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'frontend.out.log') -RedirectStandardError (Join-Path $logDir 'frontend.err.log') -PassThru } else { $null }
Write-Output "Backend: $(if($backend){'started PID '+$backend.Id}else{'already running'}); Frontend: $(if($frontend){'started PID '+$frontend.Id}else{'already running'})"
Write-Output "Studio: http://127.0.0.1:50189/#/studio"
Write-Output "Professional: http://127.0.0.1:50189/#/professional"
Write-Output "Data: $dataDir"
if ($OwnerUserId -eq 0) { Write-Warning 'No unique existing owner account was found. Revision Confirm stays disabled until an owner account exists and this launcher is restarted.' }
