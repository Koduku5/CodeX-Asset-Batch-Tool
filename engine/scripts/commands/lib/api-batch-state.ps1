# Saved configuration and active-generation state for start_api_batch.ps1.

function Clear-StaleQueueBuildLockBeforeForm {
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $false }
  $lock = Read-PipelineLockFile -Path $lockPath
  if ([string]$lock.kind -cne 'queue_build') { return $false }

  $ownerState = Get-PipelineLockOwnerState -Lock $lock
  if ($ownerState -eq 'alive') {
    throw "出图队列仍在建立中（进程 $($lock.processId)），请等待完成后再试。"
  }
  if ($ownerState -eq 'unknown') {
    throw '建队锁缺少可验证的协议 v2 进程身份，禁止自动清理。请确认旧任务已停止后再处理该锁。'
  }
  if (-not (Remove-StaleTransientPipelineLock -Path $lockPath -AllowedKinds @('queue_build'))) {
    throw '建队锁在恢复检查期间发生变化，禁止自动清理。'
  }
  return $true
}

function Get-ApiAttemptLedgerEntry {
  param(
    [Parameter(Mandatory = $true)] [object]$State,
    [Parameter(Mandatory = $true)] [object]$Item
  )

  $expectedFingerprint = ([string]$Item.inputFingerprint).Trim()
  $entry = $null
  $ledgerProperty = $State.PSObject.Properties['attemptLedger']
  if ($null -ne $ledgerProperty -and $null -ne $ledgerProperty.Value) {
    $apiProperty = $ledgerProperty.Value.PSObject.Properties['api']
    if ($null -ne $apiProperty) { $entry = $apiProperty.Value }
  }

  $entryFingerprint = if ($null -ne $entry) {
    ([string]$entry.inputFingerprint).Trim()
  } else {
    ''
  }
  $useLegacy = (
    [string]$State.backend -ceq 'api' -and
    ([string]$State.inputFingerprint).Trim() -ceq $expectedFingerprint -and
    $entryFingerprint -cne $expectedFingerprint
  )
  $attempts = 0
  $lastError = ''
  $updatedAt = ''
  $matches = $false
  if ($entryFingerprint -ceq $expectedFingerprint -and $expectedFingerprint) {
    [void][int]::TryParse([string]$entry.attempts, [ref]$attempts)
    $lastError = [string]$entry.lastError
    $updatedAt = [string]$entry.updatedAt
    $matches = $true
  } elseif ($useLegacy) {
    [void][int]::TryParse([string]$State.attempts, [ref]$attempts)
    $lastError = [string]$State.error
    $updatedAt = [string]$State.updatedAt
    $matches = $true
  }
  if ($attempts -lt 0) { $attempts = 0 }
  return [pscustomobject]@{
    FingerprintMatches = $matches
    Attempts = $attempts
    LastError = $lastError
    UpdatedAt = $updatedAt
  }
}

function Test-ActiveAssetApiGeneration {
  param(
    [Parameter(Mandatory = $true)] [object]$Queue,
    [Parameter(Mandatory = $true)] [object]$Progress
  )

  if ($Queue.items -isnot [Array] -or $null -eq $Progress.items) { return $false }
  foreach ($item in $Queue.items) {
    $key = ([string]$item.key).Trim()
    $stateProperty = if ($key) { $Progress.items.PSObject.Properties[$key] } else { $null }
    if ($null -eq $stateProperty) { continue }
    $state = $stateProperty.Value
    $apiAttempt = Get-ApiAttemptLedgerEntry -State $state -Item $item
    if (
      [string]$state.backend -ceq 'api' -and
      [string]$state.status -ceq 'generating' -and
      $apiAttempt.FingerprintMatches
    ) {
      return $true
    }
  }
  return $false
}

function Get-SavedAssetApiConfiguration {
  if (
    -not (Test-Path -LiteralPath $queuePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $progressPath -PathType Leaf)
  ) {
    return $null
  }
  try {
    $queue = Get-Content -LiteralPath $queuePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $progress = Get-Content -LiteralPath $progressPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw '现有出图队列或进度无法读取；为避免覆盖可恢复任务，API 启动已停止。'
  }
  if ($queue.items -isnot [Array] -or $null -eq $progress.items) { return $null }

  $queueOperation = ([string]$queue.operation).Trim()
  if (-not $queueOperation) { $queueOperation = 'generate' }
  if ($queueOperation -notin @('generate', 'reference_redraw')) {
    throw "现有出图队列的 operation 无效：$queueOperation"
  }

  $states = @()
  foreach ($item in $queue.items) {
    $key = ([string]$item.key).Trim()
    if (-not $key) { continue }
    $property = $progress.items.PSObject.Properties[$key]
    if ($property -and [string]$property.Value.backend -ceq 'api') {
      $states += $property.Value
    }
  }
  $hasPipelineLock = Test-Path -LiteralPath $lockPath -PathType Leaf
  $pipelineLock = $null
  if ($hasPipelineLock) {
    try {
      $pipelineLock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      throw "流水线锁无法读取，禁止猜测恢复：$lockPath"
    }
  }
  $lockOperation = if ($pipelineLock) { ([string]$pipelineLock.operation).Trim() } else { '' }
  $hasApiBatchLock = (
    $pipelineLock -and
    [string]$pipelineLock.kind -ceq 'image_generation_batch' -and
    $lockOperation -cne 'directory_redraw' -and
    [string]$pipelineLock.key -cne 'directory_redraw'
  )
  $batchConfiguration = $progress.apiBatch.configuration
  $requiredBatchFields = @('operation', 'baseUrl', 'projectId', 'modelId', 'aspectRatio', 'imageSize')
  $batchConfigurationValid = $null -ne $batchConfiguration
  if ($batchConfigurationValid) {
    foreach ($field in $requiredBatchFields) {
      if ([string]::IsNullOrWhiteSpace([string]$batchConfiguration.PSObject.Properties[$field].Value)) {
        $batchConfigurationValid = $false
        break
      }
    }
  }
  if (
    -not $batchConfigurationValid -and
    $pipelineLock -and
    $hasApiBatchLock
  ) {
    $batchConfiguration = $pipelineLock
    $batchConfigurationValid = $true
    foreach ($field in $requiredBatchFields) {
      if ([string]::IsNullOrWhiteSpace([string]$batchConfiguration.PSObject.Properties[$field].Value)) {
        $batchConfigurationValid = $false
        break
      }
    }
  }
  if ($batchConfigurationValid -and [string]$batchConfiguration.operation -cne $queueOperation) {
    throw 'API 批次配置中的任务类型与出图队列不一致，禁止猜测恢复。'
  }
  if (-not $states.Count -and -not $batchConfigurationValid) {
    if ($hasApiBatchLock) {
      throw 'API 恢复锁缺少安全恢复所需的批次配置；请确认旧任务已停止后重置该批次。'
    }
    return $null
  }
  $hasGeneratingState = Test-ActiveAssetApiGeneration -Queue $queue -Progress $progress
  $allQueueItemsTerminal = $queue.items.Count -gt 0
  foreach ($item in $queue.items) {
    $key = ([string]$item.key).Trim()
    $stateProperty = if ($key) { $progress.items.PSObject.Properties[$key] } else { $null }
    if ($null -eq $stateProperty) {
      $allQueueItemsTerminal = $false
      break
    }
    $state = $stateProperty.Value
    $status = [string]$state.status
    $apiAttempt = Get-ApiAttemptLedgerEntry -State $state -Item $item
    if (
      $status -ceq 'generating' -and
      [string]$state.backend -ceq 'api' -and
      $apiAttempt.FingerprintMatches
    ) {
      $allQueueItemsTerminal = $false
      break
    }
    $currentApiFailure = (
      $apiAttempt.FingerprintMatches -and
      [string]$state.backend -ceq 'api' -and
      $status -ceq 'failed'
    )
    $terminalFailure = (
      ($currentApiFailure -and [bool]$state.terminal) -or
      (
        $apiAttempt.FingerprintMatches -and
        $apiAttempt.Attempts -ge 2 -and
        ($apiAttempt.LastError -or $currentApiFailure)
      )
    )
    $completed = (
      $apiAttempt.FingerprintMatches -and
      [string]$state.backend -ceq 'api' -and
      $status -ceq 'completed'
    )
    if (-not $completed -and -not $terminalFailure) {
      $allQueueItemsTerminal = $false
      break
    }
  }
  $canvasStatus = ([string]$progress.apiBatch.canvasStatus).Trim()
  if ($allQueueItemsTerminal -and -not $hasApiBatchLock -and $canvasStatus -ne 'failed') {
    return $null
  }

  $configuration = [ordered]@{}
  $fieldMap = [ordered]@{
    BaseUrl = 'baseUrl'
    ProjectId = 'projectId'
    ModelId = 'modelId'
    AspectRatio = 'aspectRatio'
    ImageSize = 'imageSize'
  }
  foreach ($targetField in $fieldMap.Keys) {
    $sourceField = $fieldMap[$targetField]
    $values = @(
      $states |
        ForEach-Object { ([string]$_.PSObject.Properties[$sourceField].Value).Trim() } |
        Where-Object { $_ } |
        Select-Object -Unique
    )
    if (-not $values.Count -and $batchConfigurationValid) {
      $values = @(([string]$batchConfiguration.PSObject.Properties[$sourceField].Value).Trim())
    }
    if ($values.Count -gt 1) {
      throw "当前队列含有互相冲突的 API 配置（$sourceField）；禁止猜测恢复。"
    }
    if (-not $values.Count) {
      throw "当前队列的 API 进度缺少 $sourceField；禁止在未知配置下继续。"
    }
    $configuration[$targetField] = $values[0]
  }
  $promptTemplates = $null
  $apiPromptBatchProperty = $queue.PSObject.Properties['apiPromptBatch']
  if ($null -ne $apiPromptBatchProperty) {
    $apiPromptBatch = $apiPromptBatchProperty.Value
    if ($null -ne $apiPromptBatch) {
      $batchNames = @($apiPromptBatch.PSObject.Properties.Name)
      $batchKeysValid = ($batchNames.Count -eq 3)
      foreach ($requiredName in @('version', 'confirmedAt', 'bySheet')) {
        if ($batchNames -cnotcontains $requiredName) { $batchKeysValid = $false }
      }
      if (
        $batchKeysValid -and
        [int]$apiPromptBatch.version -eq 2 -and
        -not [string]::IsNullOrWhiteSpace([string]$apiPromptBatch.confirmedAt) -and
        (Test-ApiPromptTemplates -Templates $apiPromptBatch.bySheet)
      ) {
        $promptTemplates = Copy-ApiPromptTemplates -Templates $apiPromptBatch.bySheet
      }
    }
  }
  $configuration['PromptTemplates'] = $promptTemplates
  $configuration['PromptTemplatesAvailable'] = ($null -ne $promptTemplates)
  $configuration['Operation'] = $queueOperation
  $configuration['ModeLocked'] = ($hasGeneratingState -or $hasApiBatchLock)
  return [pscustomobject]$configuration
}

function Get-SavedDirectoryRedrawConfiguration {
  $pipelineLock = $null
  if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
    try {
      $pipelineLock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      throw "流水线锁无法读取，禁止猜测恢复：$lockPath"
    }
  }
  $hasDirectoryLock = (
    $pipelineLock -and
    [string]$pipelineLock.kind -ceq 'image_generation_batch' -and
    (
      [string]$pipelineLock.operation -ceq 'directory_redraw' -or
      [string]$pipelineLock.key -ceq 'directory_redraw'
    )
  )
  if (
    -not (Test-Path -LiteralPath $directoryRedrawQueuePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $directoryRedrawProgressPath -PathType Leaf)
  ) {
    if ($hasDirectoryLock) {
      throw '发现文件夹批量重绘恢复锁，但专用队列或进度文件缺失，禁止猜测恢复。'
    }
    return $null
  }

  try {
    $queue = Get-Content -LiteralPath $directoryRedrawQueuePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $progress = Get-Content -LiteralPath $directoryRedrawProgressPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw '文件夹批量重绘的队列或进度无法读取；为避免重复提交，API 启动已停止。'
  }
  if (
    [int]$queue.version -ne 1 -or
    [string]$queue.operation -cne 'directory_redraw' -or
    $queue.items -isnot [Array] -or
    $null -eq $progress.items
  ) {
    if ($hasDirectoryLock) {
      throw '文件夹批量重绘恢复状态结构无效，禁止猜测恢复。'
    }
    return $null
  }
  $blankQueue = @($queue.items).Count -eq 0
  $blankProgress = @($progress.items.PSObject.Properties).Count -eq 0 -and $null -eq $progress.apiBatch
  if ($blankQueue -and $blankProgress -and -not $hasDirectoryLock) {
    return $null
  }

  $sourceRoot = ([string]$queue.sourceRoot).Trim()
  $outputRoot = ([string]$queue.outputRoot).Trim()
  $redrawPrompt = Normalize-PromptTemplate ([string]$queue.prompt)
  if (-not $sourceRoot -or -not $outputRoot -or -not $redrawPrompt) {
    throw '文件夹批量重绘队列缺少原图目录、结果目录或统一重绘要求。'
  }

  $states = @()
  foreach ($item in $queue.items) {
    $key = ([string]$item.key).Trim()
    if (-not $key) { continue }
    $property = $progress.items.PSObject.Properties[$key]
    if ($property -and [string]$property.Value.backend -ceq 'api') {
      $states += $property.Value
    }
  }

  $batchConfiguration = $progress.apiBatch.configuration
  $requiredBatchFields = @('operation', 'baseUrl', 'projectId', 'modelId', 'aspectRatio', 'imageSize')
  $batchConfigurationValid = $null -ne $batchConfiguration
  if ($batchConfigurationValid) {
    foreach ($field in $requiredBatchFields) {
      if ([string]::IsNullOrWhiteSpace([string]$batchConfiguration.PSObject.Properties[$field].Value)) {
        $batchConfigurationValid = $false
        break
      }
    }
  }
  if (-not $batchConfigurationValid -and $hasDirectoryLock) {
    $batchConfiguration = $pipelineLock
    $batchConfigurationValid = $true
    foreach ($field in $requiredBatchFields) {
      if ([string]::IsNullOrWhiteSpace([string]$batchConfiguration.PSObject.Properties[$field].Value)) {
        $batchConfigurationValid = $false
        break
      }
    }
  }
  if ($batchConfigurationValid -and [string]$batchConfiguration.operation -cne 'directory_redraw') {
    throw '文件夹批量重绘的批次配置与队列操作类型不一致。'
  }
  if (-not $states.Count -and -not $batchConfigurationValid) {
    if ($hasDirectoryLock) {
      throw '文件夹批量重绘恢复锁缺少安全恢复所需的 API 配置。'
    }
    return $null
  }

  $allQueueItemsTerminal = $queue.items.Count -gt 0
  foreach ($item in $queue.items) {
    $key = ([string]$item.key).Trim()
    $property = if ($key) { $progress.items.PSObject.Properties[$key] } else { $null }
    if ($null -eq $property -or [string]$property.Value.backend -cne 'api') {
      $allQueueItemsTerminal = $false
      break
    }
    $state = $property.Value
    $terminalFailure = (
      [string]$state.status -ceq 'failed' -and
      ([bool]$state.terminal -or ([int]$state.attempts -ge 2))
    )
    if ([string]$state.status -cne 'completed' -and -not $terminalFailure) {
      $allQueueItemsTerminal = $false
      break
    }
  }
  $canvasStatus = ([string]$progress.apiBatch.canvasStatus).Trim()
  if ($allQueueItemsTerminal -and -not $hasDirectoryLock -and $canvasStatus -ne 'failed') {
    return $null
  }

  $configuration = [ordered]@{
    Operation = 'directory_redraw'
    SourceRoot = $sourceRoot
    OutputRoot = $outputRoot
    RedrawPrompt = $redrawPrompt
    PromptTemplates = $null
    PromptTemplatesAvailable = $false
    ModeLocked = $true
  }
  $fieldMap = [ordered]@{
    BaseUrl = 'baseUrl'
    ProjectId = 'projectId'
    ModelId = 'modelId'
    AspectRatio = 'aspectRatio'
    ImageSize = 'imageSize'
  }
  foreach ($targetField in $fieldMap.Keys) {
    $sourceField = $fieldMap[$targetField]
    $values = @(
      $states |
        ForEach-Object { ([string]$_.PSObject.Properties[$sourceField].Value).Trim() } |
        Where-Object { $_ } |
        Select-Object -Unique
    )
    if (-not $values.Count -and $batchConfigurationValid) {
      $values = @(([string]$batchConfiguration.PSObject.Properties[$sourceField].Value).Trim())
    }
    if ($values.Count -gt 1) {
      throw "文件夹批量重绘含有互相冲突的 API 配置（$sourceField）。"
    }
    if (-not $values.Count) {
      throw "文件夹批量重绘进度缺少 $sourceField，禁止在未知配置下继续。"
    }
    $configuration[$targetField] = $values[0]
  }
  return [pscustomobject]$configuration
}

function Get-SavedApiConfiguration {
  $assetConfiguration = Get-SavedAssetApiConfiguration
  $directoryConfiguration = Get-SavedDirectoryRedrawConfiguration
  if ($assetConfiguration -and $directoryConfiguration) {
    if ([bool]$assetConfiguration.ModeLocked -and [bool]$directoryConfiguration.ModeLocked) {
      throw '普通资产出图与文件夹批量重绘同时存在运行中状态，禁止猜测需要恢复的批次。'
    }
    if ([bool]$directoryConfiguration.ModeLocked) { return $directoryConfiguration }
    if ([bool]$assetConfiguration.ModeLocked) { return $assetConfiguration }
    return $directoryConfiguration
  }
  if ($directoryConfiguration) { return $directoryConfiguration }
  return $assetConfiguration
}
