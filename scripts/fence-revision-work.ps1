param(
  [Parameter(Mandatory = $true)][long]$ProjectId,
  [Parameter(Mandatory = $true)][long]$ScriptId,
  [Parameter(Mandatory = $true)][string]$GuardId,
  [Parameter(Mandatory = $true)][string]$Reason,
  [string]$BaseUrl = 'http://127.0.0.1:10588'
)

$secureToken = Read-Host 'Studio owner session token' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
  $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $body = @{ projectId = $ProjectId; scriptId = $ScriptId; guardId = $GuardId; reason = $Reason } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri ($BaseUrl.TrimEnd('/') + '/api/stageOrchestrator/revision/workGuard/fence') `
    -ContentType 'application/json' -Headers @{ Authorization = "Bearer $plainToken" } -Body $body
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $plainToken = $null
}
