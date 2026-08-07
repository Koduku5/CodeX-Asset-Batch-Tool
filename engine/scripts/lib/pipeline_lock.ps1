function Get-PipelineCurrentProcessStartTime {
  $process = Get-Process -Id $PID -ErrorAction Stop
  return $process.StartTime.ToUniversalTime().ToString('o')
}

function New-PipelineLockPayload {
  param(
    [Parameter(Mandatory = $true)][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Key,
    [ValidateSet('transient', 'durable')][string]$LeaseMode = 'transient',
    [hashtable]$Additional = @{}
  )

  $now = (Get-Date).ToUniversalTime().ToString('o')
  $payload = [ordered]@{
    protocolVersion = 2
    kind = $Kind
    key = $Key
    leaseMode = $LeaseMode
    processId = $PID
    processStartTime = Get-PipelineCurrentProcessStartTime
    host = [Environment]::MachineName
    token = [guid]::NewGuid().ToString('N')
    createdAt = $now
    updatedAt = $now
  }
  foreach ($name in $Additional.Keys) {
    $payload[$name] = $Additional[$name]
  }
  return $payload
}

function Read-PipelineLockFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $lock = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "流水线锁无法读取，禁止猜测恢复：$Path"
  }
  if (
    $lock -isnot [pscustomobject] -or
    [string]::IsNullOrWhiteSpace([string]$lock.kind) -or
    [string]::IsNullOrWhiteSpace([string]$lock.key)
  ) {
    throw "流水线锁结构无效，禁止继续：$Path"
  }
  return $lock
}

function Get-PipelineProcessIdentityState {
  param(
    [Parameter(Mandatory = $true)][object]$ProcessId,
    [Parameter(Mandatory = $true)][object]$ProcessStartTime,
    [Parameter(Mandatory = $true)][object]$HostName
  )
  if ([string]$HostName -ine [Environment]::MachineName) { return 'unknown' }
  $ownerPid = 0
  if (-not [int]::TryParse([string]$ProcessId, [ref]$ownerPid) -or $ownerPid -lt 1) {
    return 'unknown'
  }
  try {
    $expectedStart = [DateTimeOffset]::Parse([string]$ProcessStartTime).UtcDateTime
  } catch {
    return 'unknown'
  }
  $process = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($null -eq $process) { return 'dead' }
  try {
    $actualStart = $process.StartTime.ToUniversalTime()
  } catch {
    return 'unknown'
  }
  if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -le 5) {
    return 'alive'
  }
  return 'identity_mismatch'
}

function Get-PipelineLockOwnerState {
  param([Parameter(Mandatory = $true)][object]$Lock)

  if (
    [int]$Lock.protocolVersion -ne 2 -or
    [string]$Lock.leaseMode -cne 'transient' -or
    [string]::IsNullOrWhiteSpace([string]$Lock.token)
  ) {
    return 'unknown'
  }
  return Get-PipelineProcessIdentityState `
    -ProcessId $Lock.processId `
    -ProcessStartTime $Lock.processStartTime `
    -HostName $Lock.host
}

function Remove-StaleTransientPipelineLock {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$AllowedKinds = @()
  )

  $lock = Read-PipelineLockFile -Path $Path
  if ($null -eq $lock) { return $false }
  if ($AllowedKinds.Count -and [string]$lock.kind -notin $AllowedKinds) { return $false }
  $state = Get-PipelineLockOwnerState -Lock $lock
  if ($state -notin @('dead', 'identity_mismatch')) { return $false }

  $latest = Read-PipelineLockFile -Path $Path
  if (
    $null -eq $latest -or
    [string]$latest.token -cne [string]$lock.token -or
    [string]$latest.kind -cne [string]$lock.kind
  ) {
    throw '流水线锁在恢复检查期间发生变化，禁止自动清理。'
  }

  $quarantine = "$Path.stale.$([string]$lock.token).$([guid]::NewGuid().ToString('N'))"
  try {
    Move-Item -LiteralPath $Path -Destination $quarantine -ErrorAction Stop
  } catch {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
    throw '无法隔离已确认失效的流水线锁，禁止继续。'
  }
  Remove-Item -LiteralPath $quarantine -Force -ErrorAction SilentlyContinue
  return $true
}
