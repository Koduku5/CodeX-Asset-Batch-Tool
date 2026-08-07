[CmdletBinding()]
param(
  [string]$OnlyQueueKey = '',
  [string]$Operation = '',
  [switch]$Headless
)

$ErrorActionPreference = 'Stop'
trap {
  try {
    if ($Headless) { throw $_.Exception }
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show(
      $_.Exception.Message,
      '无限画板 API 启动失败',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch { if ($Headless) { [Console]::Error.WriteLine($_.Exception.Message) } }
  exit 1
}
$utf8 = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8
try { [Console]::InputEncoding = $utf8 } catch {}
try { [Console]::OutputEncoding = $utf8 } catch {}
chcp.com 65001 | Out-Null

$skillRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pipelineLockHelper = Join-Path $skillRoot 'scripts\lib\pipeline_lock.ps1'
$boundedStreamHelper = Join-Path $skillRoot 'scripts\lib\bounded_stream.ps1'
$environmentCheck = Join-Path $PSScriptRoot 'check_environment.ps1'
$nodeRunner = Join-Path $PSScriptRoot 'node.ps1'
$pythonRunner = Join-Path $PSScriptRoot 'python.ps1'
$promptCatalogCli = Join-Path $skillRoot 'scripts\pipeline\prompt_catalog_cli.mjs'
$queueBuilder = Join-Path $skillRoot 'scripts\pipeline\build_image_queue.mjs'
$directoryRedrawQueueBuilder = Join-Path $skillRoot 'scripts\pipeline\build_directory_redraw_queue.mjs'
$batchRunner = Join-Path $skillRoot 'scripts\pipeline\batch_generate_images.py'
$lockPath = Join-Path $skillRoot 'cache\.pipeline.lock'
$queuePath = Join-Path $skillRoot 'cache\出图队列.json'
$progressPath = Join-Path $skillRoot 'cache\出图进度.json'
$directoryRedrawCachePath = Join-Path $skillRoot 'cache\批量重绘'
$directoryRedrawQueuePath = Join-Path $directoryRedrawCachePath '队列.json'
$directoryRedrawProgressPath = Join-Path $directoryRedrawCachePath '进度.json'
$sheetOrder = @('角色', '生物', '群演', '场景', '道具')
$OnlyQueueKey = $OnlyQueueKey.Trim()
if ($OnlyQueueKey -match "[`r`n]") {
  throw '单项测试的队列 Key 不能包含换行。'
}
$Operation = $Operation.Trim()
if ($Operation -and $Operation -notin @('generate', 'reference_redraw', 'directory_redraw')) {
  throw "无效的 API 操作模式：$Operation"
}
$defaultApiPromptTemplates = $null

foreach ($required in @(
  $pipelineLockHelper,
  $boundedStreamHelper,
  $environmentCheck,
  $nodeRunner,
  $pythonRunner,
  $promptCatalogCli,
  $queueBuilder,
  $directoryRedrawQueueBuilder,
  $batchRunner
)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "缺少 API 批量出图组件：$required"
  }
}

$apiTemplateOutput = @()
try {
  $apiTemplateOutput = @(& $nodeRunner $promptCatalogCli 'api-defaults' '--legacy-names' 2>&1)
  $apiTemplateExitCode = $LASTEXITCODE
} catch {
  throw "API 默认提示词注册表 CLI 无法启动：$($_.Exception.Message)"
}
$apiTemplateJson = ($apiTemplateOutput | ForEach-Object { [string]$_ }) -join "`n"
if ($apiTemplateExitCode -ne 0) {
  $detail = if ([string]::IsNullOrWhiteSpace($apiTemplateJson)) {
    "退出码 $apiTemplateExitCode"
  } else {
    $apiTemplateJson.Trim()
  }
  throw "API 默认提示词注册表 CLI 失败：$detail"
}
try {
  $defaultApiPromptTemplates = $apiTemplateJson | ConvertFrom-Json
} catch {
  throw "API 默认提示词注册表 CLI 返回了无效 JSON：$($_.Exception.Message)"
}
$apiTemplateNames = @($defaultApiPromptTemplates.PSObject.Properties.Name)
if (($apiTemplateNames -join '|') -cne ($sheetOrder -join '|')) {
  throw "API 默认提示词注册表必须且只能提供：$($sheetOrder -join '、')。"
}
foreach ($sheetName in $sheetOrder) {
  $template = [string]$defaultApiPromptTemplates.PSObject.Properties[$sheetName].Value
  if ([string]::IsNullOrWhiteSpace($template)) {
    throw "API 默认提示词注册表中的「$sheetName」模板为空。"
  }
}

. $pipelineLockHelper
. $boundedStreamHelper
$maxApiJsonResponseBytes = 8MB

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class KaConsoleWindow {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()

function Normalize-BaseUrl {
  param([string]$Value)
  $raw = ([string]$Value).Trim()
  $uri = $null
  if (
    -not [Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$uri) -or
    $uri.Scheme -notin @('http', 'https') -or
    [string]::IsNullOrWhiteSpace($uri.DnsSafeHost)
  ) {
    throw '服务地址必须是完整的 http:// 或 https:// 地址。'
  }
  if ($uri.DnsSafeHost.Contains('%')) {
    throw '暂不支持带接口作用域标识的 IPv6 服务地址；请改用无作用域地址、私网 IPv4，或 HTTPS 域名。'
  }
  if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) {
    throw '服务地址不能包含账号密码、查询参数或片段标记。'
  }
  $normalizedPath = $uri.AbsolutePath.TrimEnd('/')
  if ($normalizedPath.EndsWith('/api/v1', [StringComparison]::OrdinalIgnoreCase)) {
    $normalizedPath = $normalizedPath.Substring(0, $normalizedPath.Length - 7).TrimEnd('/')
  }
  $builder = New-Object UriBuilder($uri)
  $builder.Path = if ($normalizedPath) { $normalizedPath } else { '/' }
  $builder.Query = ''
  $builder.Fragment = ''
  $normalized = $builder.Uri.AbsoluteUri.TrimEnd('/')
  if ($uri.Scheme -ieq 'http' -and -not (Test-PrivateApiIpLiteral $normalized)) {
    throw 'API 域名必须使用 HTTPS；HTTP 只允许 URL 主机直接填写私网、本机或链路本地 IP 地址，以防止 DNS 重绑定。'
  }
  return $normalized
}

function Test-PrivateIpAddress {
  param([Net.IPAddress]$Address)
  if ([Net.IPAddress]::IsLoopback($Address)) { return $true }
  if (
    $Address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6 -and
    $Address.IsIPv4MappedToIPv6
  ) {
    return (Test-PrivateIpAddress -Address ($Address.MapToIPv4()))
  }
  if ($Address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) {
    $bytes = $Address.GetAddressBytes()
    return (
      $bytes[0] -eq 10 -or
      ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
      ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or
      ($bytes[0] -eq 169 -and $bytes[1] -eq 254)
    )
  }
  if ($Address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) {
    $bytes = $Address.GetAddressBytes()
    return (
      $Address.IsIPv6LinkLocal -or
      (($bytes[0] -band 0xFE) -eq 0xFC)
    )
  }
  return $false
}

function Test-PrivateApiIpLiteral {
  param([string]$BaseUrl)
  $uri = [Uri]$BaseUrl
  $address = $null
  $hostText = $uri.DnsSafeHost.Trim('[', ']')
  if (-not [Net.IPAddress]::TryParse($hostText, [ref]$address)) {
    return $false
  }
  return (Test-PrivateIpAddress -Address $address)
}

function Test-PrivateApiHost {
  param([string]$BaseUrl)
  $uri = [Uri]$BaseUrl
  try {
    $addresses = @([Net.Dns]::GetHostAddresses($uri.DnsSafeHost))
  } catch {
    return $false
  }
  if (-not $addresses.Count) { return $false }
  return -not @($addresses | Where-Object { -not (Test-PrivateIpAddress $_) }).Count
}

function Read-Utf8JsonResponse {
  param([Net.WebResponse]$Response)
  $stream = $null
  try {
    $stream = $Response.GetResponseStream()
    if ($null -eq $stream) { return $null }
    $bytes = Read-LimitedStreamBytes `
      -Stream $stream `
      -DeclaredLength ([long]$Response.ContentLength) `
      -MaxBytes $maxApiJsonResponseBytes `
      -Label 'API JSON 响应'
  } finally {
    if ($stream) { $stream.Dispose() }
    $Response.Dispose()
  }
  if ($bytes.Length -eq 0) { return $null }
  $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
  if (-not $text.Trim()) { return $null }
  return $text | ConvertFrom-Json
}

function Invoke-Utf8JsonRequest {
  param(
    [ValidateSet('GET', 'POST', 'PUT', 'DELETE')]
    [string]$Method,
    [string]$Uri,
    [hashtable]$Headers = @{},
    [byte[]]$Body = $null,
    [int]$TimeoutSec = 30
  )
  $request = [Net.HttpWebRequest][Net.WebRequest]::Create($Uri)
  $request.Method = $Method
  $request.Accept = 'application/json'
  $request.Timeout = $TimeoutSec * 1000
  $request.ReadWriteTimeout = $TimeoutSec * 1000
  $request.AllowAutoRedirect = $false
  $request.AutomaticDecompression = (
    [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
  )
  foreach ($name in $Headers.Keys) {
    if ($name -ieq 'Authorization') {
      $request.Headers[[Net.HttpRequestHeader]::Authorization] = [string]$Headers[$name]
    } elseif ($name -ieq 'Content-Type') {
      $request.ContentType = [string]$Headers[$name]
    } elseif ($name -ieq 'Accept') {
      $request.Accept = [string]$Headers[$name]
    } else {
      $request.Headers[$name] = [string]$Headers[$name]
    }
  }
  if ($null -ne $Body) {
    if (-not $request.ContentType) { $request.ContentType = 'application/json; charset=utf-8' }
    $request.ContentLength = $Body.Length
    $requestStream = $request.GetRequestStream()
    try {
      $requestStream.Write($Body, 0, $Body.Length)
    } finally {
      $requestStream.Dispose()
    }
  }
  try {
    $response = $request.GetResponse()
    $status = [int]$response.StatusCode
    if ($status -ge 300 -and $status -lt 400) {
      $location = [string]$response.Headers['Location']
      $response.Dispose()
      throw "API 拒绝自动跟随 HTTP $status 重定向：$location"
    }
    return Read-Utf8JsonResponse $response
  } catch [Net.WebException] {
    $response = $_.Exception.Response
    if ($null -eq $response) { throw }
    $status = [int]$response.StatusCode
    try {
      $payload = Read-Utf8JsonResponse $response
      $message = ([string]$payload.message).Trim()
      if (-not $message) { $message = ([string]$payload.error).Trim() }
    } catch {
      $message = ''
    }
    if (-not $message) { $message = $_.Exception.Message }
    throw "HTTP $status：$message"
  }
}

function Hide-KaConsole {
  $window = [KaConsoleWindow]::GetConsoleWindow()
  if ($window -eq [IntPtr]::Zero) { return $false }
  [void][KaConsoleWindow]::ShowWindow($window, 0)
  return $true
}

function Show-KaConsole {
  $window = [KaConsoleWindow]::GetConsoleWindow()
  if ($window -ne [IntPtr]::Zero) {
    [void][KaConsoleWindow]::ShowWindow($window, 5)
  }
}

function Get-CollectionFromResponse {
  param(
    $Response,
    [string[]]$PropertyNames
  )
  if ($Response -is [Array]) { return @($Response) }
  foreach ($propertyName in $PropertyNames) {
    $property = $Response.PSObject.Properties[$propertyName]
    if ($property -and $null -ne $property.Value) { return @($property.Value) }
  }
  return @()
}

function New-DisplayItem {
  param($Source, [string]$FallbackName)
  $id = ([string]$Source.id).Trim()
  if (-not $id) { return $null }
  $name = ([string]$Source.display_name).Trim()
  if (-not $name) { $name = ([string]$Source.name).Trim() }
  if (-not $name) { $name = $FallbackName }
  return [pscustomobject]@{
    Text = "$name  [$id]"
    Id = $id
  }
}

function Select-ComboItemById {
  param(
    [System.Windows.Forms.ComboBox]$ComboBox,
    [string]$Id
  )
  for ($index = 0; $index -lt $ComboBox.Items.Count; $index++) {
    if ([string]$ComboBox.Items[$index].Id -ceq $Id) {
      $ComboBox.SelectedIndex = $index
      return $true
    }
  }
  return $false
}

function Normalize-PromptTemplate {
  param([string]$Value)
  return ([string]$Value).Replace("`r`n", "`n").Replace("`r", "`n").Trim()
}

function Test-ApiPromptTemplates {
  param([object]$Templates)
  if ($null -eq $Templates) { return $false }
  $names = @($Templates.PSObject.Properties.Name)
  if ($names.Count -ne $sheetOrder.Count) { return $false }
  foreach ($sheetName in $sheetOrder) {
    $property = $Templates.PSObject.Properties[$sheetName]
    if ($null -eq $property -or $property.Value -isnot [string]) { return $false }
  }
  return $true
}

function Copy-ApiPromptTemplates {
  param([object]$Templates)
  $copy = [ordered]@{}
  foreach ($sheetName in $sheetOrder) {
    $copy[$sheetName] = Normalize-PromptTemplate ([string]$Templates.PSObject.Properties[$sheetName].Value)
  }
  return [pscustomobject]$copy
}

function Convert-ApiPromptTemplatesToBase64 {
  param([object]$Templates)
  if (-not (Test-ApiPromptTemplates -Templates $Templates)) {
    throw 'API 提示词模板结构无效。'
  }
  $json = ConvertTo-Json -InputObject (Copy-ApiPromptTemplates -Templates $Templates) -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  if ($encoded.Length -gt 30000) {
    throw '五类 API 提示词模板总长度过大，请精简后再开始。'
  }
  return $encoded
}

function Convert-DirectoryRedrawConfigToBase64 {
  param(
    [string]$SourceRoot,
    [string]$OutputRoot,
    [string]$Prompt
  )
  $configuration = [ordered]@{
    sourceRoot = ([string]$SourceRoot).Trim()
    outputRoot = ([string]$OutputRoot).Trim()
    prompt = Normalize-PromptTemplate $Prompt
  }
  if (-not $configuration.sourceRoot -or -not $configuration.outputRoot -or -not $configuration.prompt) {
    throw '文件夹批量重绘的原图目录、结果目录和统一重绘要求均不能为空。'
  }
  $json = ConvertTo-Json -InputObject $configuration -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  if ($encoded.Length -gt 30000) {
    throw '文件夹批量重绘配置过长，请精简统一重绘要求。'
  }
  return $encoded
}

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

$recoveredStaleQueueBuild = Clear-StaleQueueBuildLockBeforeForm
$savedApiConfiguration = if ($recoveredStaleQueueBuild) { $null } else { Get-SavedApiConfiguration }
$initialOperation = if ($Operation) {
  $Operation
} elseif ($savedApiConfiguration) {
  [string]$savedApiConfiguration.Operation
} else {
  'generate'
}
if (
  $initialOperation -ceq 'reference_redraw' -and
  (
    $null -eq $savedApiConfiguration -or
    [string]$savedApiConfiguration.Operation -cne 'reference_redraw'
  )
) {
  throw '旧版参考图重绘只允许恢复现有未完成批次，不能再建立新任务。'
}
if (
  $savedApiConfiguration -and
  [bool]$savedApiConfiguration.ModeLocked -and
  $Operation -and
  $Operation -cne [string]$savedApiConfiguration.Operation
) {
  throw '当前 API 远端任务仍在运行或留有恢复锁，不能切换任务类型。'
}
$Operation = $initialOperation
$isDirectoryRedraw = $Operation -eq 'directory_redraw'
$isLegacyReferenceRedraw = $Operation -eq 'reference_redraw'
$operationTitle = if ($isDirectoryRedraw) {
  'API 文件夹批量重绘'
} elseif ($isLegacyReferenceRedraw) {
  'API 参考图重绘（旧批次恢复）'
} else {
  'API 批量出图'
}

if ($Headless) {
  if ($Operation -notin @('generate', 'directory_redraw')) {
    throw '后台 API 任务只支持普通资产出图或文件夹批量重绘。'
  }
  $baseUrl = Normalize-BaseUrl ([string]$env:KA_API_BASE_URL)
  $username = ([string]$env:KA_API_USERNAME).Trim()
  $password = [string]$env:KA_API_PASSWORD
  $remoteProjectId = ([string]$env:KA_API_PROJECT_ID).Trim()
  $modelId = ([string]$env:KA_API_MODEL_ID).Trim()
  if (-not $username -or -not $password -or -not $remoteProjectId -or -not $modelId) {
    throw '后台 API 任务缺少账号、密码、远端项目或模型。'
  }
  foreach ($value in @($username, $remoteProjectId, $modelId)) {
    if ($value -match "[`0`r`n]") { throw '后台 API 配置包含无效控制字符。' }
  }
  $headlessWorkers = 0
  if (
    -not [int]::TryParse([string]$env:KA_API_MAX_WORKERS, [ref]$headlessWorkers) -or
    $headlessWorkers -lt 1 -or
    $headlessWorkers -gt 16
  ) {
    throw '后台 API 并发数量必须是 1–16。'
  }
  $headlessRatio = ([string]$env:KA_API_ASPECT_RATIO).Trim()
  $headlessSize = ([string]$env:KA_API_IMAGE_SIZE).Trim()
  if ($headlessRatio -notin @('21:9', '16:9', '5:4', '4:3', '3:2', '1:1', '2:3', '3:4', '4:5', '9:16')) {
    throw '后台 API 画面比例无效。'
  }
  if ($headlessSize -notin @('1K', '2K')) {
    throw '后台 API 图片尺寸无效。'
  }
  $sourceRoot = ''
  $outputRoot = ''
  $redrawPrompt = ''
  $promptTemplates = $defaultApiPromptTemplates
  if ($Operation -eq 'generate') {
    $encodedTemplates = ([string]$env:KA_API_PROMPT_TEMPLATES_B64).Trim()
    if (-not $encodedTemplates) { throw '后台资产批量出图缺少五类 API 提示词模板。' }
    try {
      $templateBytes = [Convert]::FromBase64String($encodedTemplates)
      $templateJson = [Text.UTF8Encoding]::new($false, $true).GetString($templateBytes)
      $decodedTemplates = $templateJson | ConvertFrom-Json
    } catch {
      throw '后台 API 提示词模板传值无效。'
    }
    if (-not (Test-ApiPromptTemplates -Templates $decodedTemplates)) {
      throw '后台 API 提示词模板必须且只能包含角色、生物、群演、场景、道具五项。'
    }
    $promptTemplates = Copy-ApiPromptTemplates -Templates $decodedTemplates
  }
  if ($Operation -eq 'directory_redraw') {
    $encoded = ([string]$env:KA_REDRAW_CONFIG_B64).Trim()
    if (-not $encoded) { throw '后台文件夹批量重绘缺少目录配置。' }
    try {
      $jsonBytes = [Convert]::FromBase64String($encoded)
      $jsonText = [Text.UTF8Encoding]::new($false, $true).GetString($jsonBytes)
      $redraw = $jsonText | ConvertFrom-Json
    } catch {
      throw '后台文件夹批量重绘配置无效。'
    }
    $sourceRoot = ([string]$redraw.sourceRoot).Trim()
    $outputRoot = ([string]$redraw.outputRoot).Trim()
    $redrawPrompt = Normalize-PromptTemplate ([string]$redraw.prompt)
    if (
      -not [IO.Path]::IsPathRooted($sourceRoot) -or
      -not [IO.Path]::IsPathRooted($outputRoot) -or
      -not (Test-Path -LiteralPath $sourceRoot -PathType Container) -or
      -not (Test-Path -LiteralPath $outputRoot -PathType Container) -or
      [string]::Equals($sourceRoot.TrimEnd('\'), $outputRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
      -not $redrawPrompt
    ) {
      throw '后台文件夹批量重绘的原图目录、输出目录或统一修改要求无效。'
    }
    $promptTemplates = $null
  }
  $settings = [ordered]@{
    Operation = $Operation
    BaseUrl = $baseUrl
    Username = $username
    Password = $password
    ProjectId = $remoteProjectId
    ModelId = $modelId
    MaxWorkers = $headlessWorkers
    AspectRatio = $headlessRatio
    ImageSize = $headlessSize
    PromptTemplates = $promptTemplates
    LegacyPromptQueue = $false
    SourceRoot = $sourceRoot
    OutputRoot = $outputRoot
    RedrawPrompt = $redrawPrompt
  }
} else {
$form = New-Object System.Windows.Forms.Form
$form.Text = "Ka - $operationTitle"
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(1080, 565)
$form.MinimumSize = New-Object System.Drawing.Size(1096, 604)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = "$operationTitle 配置"
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(24, 20)
$title.AutoSize = $true
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = '填写登录信息后自动读取可用项目和生图模型；密码只在本次运行中使用，不会保存。'
$subtitle.ForeColor = [System.Drawing.Color]::DimGray
$subtitle.Location = New-Object System.Drawing.Point(26, 58)
$subtitle.Size = New-Object System.Drawing.Size(520, 38)
$form.Controls.Add($subtitle)

$directoryRedrawCheck = New-Object System.Windows.Forms.CheckBox
$directoryRedrawCheck.Text = '使用文件夹中的图片批量重绘'
$directoryRedrawCheck.Location = New-Object System.Drawing.Point(28, 91)
$directoryRedrawCheck.Size = New-Object System.Drawing.Size(420, 26)
$directoryRedrawCheck.Checked = $isDirectoryRedraw
$modeSelectionLocked = (
  $isLegacyReferenceRedraw -or
  ($null -ne $savedApiConfiguration -and [bool]$savedApiConfiguration.ModeLocked)
)
$directoryRedrawCheck.Enabled = -not $modeSelectionLocked
$form.Controls.Add($directoryRedrawCheck)

$verticalDivider = New-Object System.Windows.Forms.Label
$verticalDivider.BorderStyle = [System.Windows.Forms.BorderStyle]::Fixed3D
$verticalDivider.Location = New-Object System.Drawing.Point(565, 20)
$verticalDivider.Size = New-Object System.Drawing.Size(2, 440)
$form.Controls.Add($verticalDivider)

$templateTitle = New-Object System.Windows.Forms.Label
$templateTitle.Text = 'API 提示词模板'
$templateTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Bold)
$templateTitle.Location = New-Object System.Drawing.Point(590, 20)
$templateTitle.AutoSize = $true
$form.Controls.Add($templateTitle)

$templateSubtitle = New-Object System.Windows.Forms.Label
$templateSubtitle.Text = '最终 Prompt = 当前分类模板 + Excel“制作说明”。模板可修改或留空，不再读取外部前缀和风格文件。'
$templateSubtitle.ForeColor = [System.Drawing.Color]::DimGray
$templateSubtitle.Location = New-Object System.Drawing.Point(592, 58)
$templateSubtitle.Size = New-Object System.Drawing.Size(460, 38)
$form.Controls.Add($templateSubtitle)

$templateTabs = New-Object System.Windows.Forms.TabControl
$templateTabs.Location = New-Object System.Drawing.Point(590, 100)
$templateTabs.Size = New-Object System.Drawing.Size(462, 270)
$templateTabs.SizeMode = [System.Windows.Forms.TabSizeMode]::Fixed
$templateTabs.ItemSize = New-Object System.Drawing.Size(86, 30)
$form.Controls.Add($templateTabs)

$templateBoxes = @{}
$templatesLocked = ($null -ne $savedApiConfiguration)
$savedTemplatesAvailable = (
  $templatesLocked -and
  [bool]$savedApiConfiguration.PromptTemplatesAvailable -and
  (Test-ApiPromptTemplates -Templates $savedApiConfiguration.PromptTemplates)
)
$initialTemplates = if ($savedTemplatesAvailable) {
  $savedApiConfiguration.PromptTemplates
} else {
  $defaultApiPromptTemplates
}
foreach ($sheetName in $sheetOrder) {
  $tab = New-Object System.Windows.Forms.TabPage
  $tab.Text = $sheetName
  $tab.Padding = New-Object System.Windows.Forms.Padding(10)
  $templateTabs.TabPages.Add($tab) | Out-Null

  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true
  $box.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
  $box.AcceptsReturn = $true
  $box.WordWrap = $true
  $box.Dock = [System.Windows.Forms.DockStyle]::Fill
  $box.Text = if ($templatesLocked -and -not $savedTemplatesAvailable) {
    '旧批次没有模板快照；恢复时将继续使用队列中已经生成的 Prompt。'
  } else {
    [string]$initialTemplates.PSObject.Properties[$sheetName].Value
  }
  $box.ReadOnly = $templatesLocked
  $tab.Controls.Add($box)
  $templateBoxes[$sheetName] = $box
}

$templateState = New-Object System.Windows.Forms.Label
$templateState.Text = if ($templatesLocked) {
  if ($savedTemplatesAvailable) {
    '检测到当前队列已有 API 进度：提示词模板已按原批次锁定。'
  } else {
    '旧批次仅允许恢复；如需使用新模板，请在旧任务全部终止后清空 Cache。'
  }
} else {
  '五类模板只保存到本批次队列，不会回写 Skill 文件。'
}
$templateState.ForeColor = if ($templatesLocked) {
  [System.Drawing.Color]::DarkGoldenrod
} else {
  [System.Drawing.Color]::DimGray
}
$templateState.Location = New-Object System.Drawing.Point(592, 384)
$templateState.Size = New-Object System.Drawing.Size(460, 42)
$form.Controls.Add($templateState)

$directoryPanel = New-Object System.Windows.Forms.Panel
$directoryPanel.Location = New-Object System.Drawing.Point(590, 18)
$directoryPanel.Size = New-Object System.Drawing.Size(462, 420)
$directoryPanel.Visible = $isDirectoryRedraw
$form.Controls.Add($directoryPanel)

$directoryTitle = New-Object System.Windows.Forms.Label
$directoryTitle.Text = '文件夹批量重绘'
$directoryTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Bold)
$directoryTitle.Location = New-Object System.Drawing.Point(0, 2)
$directoryTitle.AutoSize = $true
$directoryPanel.Controls.Add($directoryTitle)

$directorySubtitle = New-Object System.Windows.Forms.Label
$directorySubtitle.Text = '逐张读取原图，并对全部图片使用同一条重绘要求；不读取 Excel、资产 ID 或分类模板。'
$directorySubtitle.ForeColor = [System.Drawing.Color]::DimGray
$directorySubtitle.Location = New-Object System.Drawing.Point(2, 40)
$directorySubtitle.Size = New-Object System.Drawing.Size(458, 38)
$directoryPanel.Controls.Add($directorySubtitle)

$sourceDirectoryLabel = New-Object System.Windows.Forms.Label
$sourceDirectoryLabel.Text = '原图文件夹（必填）'
$sourceDirectoryLabel.Location = New-Object System.Drawing.Point(2, 84)
$sourceDirectoryLabel.Size = New-Object System.Drawing.Size(180, 24)
$directoryPanel.Controls.Add($sourceDirectoryLabel)

$sourceDirectoryBox = New-Object System.Windows.Forms.TextBox
$sourceDirectoryBox.Location = New-Object System.Drawing.Point(2, 111)
$sourceDirectoryBox.Size = New-Object System.Drawing.Size(365, 28)
$savedDirectoryConfiguration = (
  $isDirectoryRedraw -and
  $null -ne $savedApiConfiguration -and
  [string]$savedApiConfiguration.Operation -ceq 'directory_redraw'
)
$sourceDirectoryBox.Text = if ($savedDirectoryConfiguration) {
  [string]$savedApiConfiguration.SourceRoot
} else {
  ''
}
$sourceDirectoryBox.ReadOnly = $savedDirectoryConfiguration
$directoryPanel.Controls.Add($sourceDirectoryBox)

$sourceDirectoryBrowse = New-Object System.Windows.Forms.Button
$sourceDirectoryBrowse.Text = '浏览…'
$sourceDirectoryBrowse.Location = New-Object System.Drawing.Point(376, 108)
$sourceDirectoryBrowse.Size = New-Object System.Drawing.Size(84, 34)
$sourceDirectoryBrowse.Enabled = -not $sourceDirectoryBox.ReadOnly
$directoryPanel.Controls.Add($sourceDirectoryBrowse)

$outputDirectoryLabel = New-Object System.Windows.Forms.Label
$outputDirectoryLabel.Text = '结果保存文件夹（必填）'
$outputDirectoryLabel.Location = New-Object System.Drawing.Point(2, 151)
$outputDirectoryLabel.Size = New-Object System.Drawing.Size(200, 24)
$directoryPanel.Controls.Add($outputDirectoryLabel)

$outputDirectoryBox = New-Object System.Windows.Forms.TextBox
$outputDirectoryBox.Location = New-Object System.Drawing.Point(2, 178)
$outputDirectoryBox.Size = New-Object System.Drawing.Size(365, 28)
$outputDirectoryBox.Text = if ($savedDirectoryConfiguration) {
  [string]$savedApiConfiguration.OutputRoot
} else {
  ''
}
$outputDirectoryBox.ReadOnly = $savedDirectoryConfiguration
$directoryPanel.Controls.Add($outputDirectoryBox)

$outputDirectoryBrowse = New-Object System.Windows.Forms.Button
$outputDirectoryBrowse.Text = '浏览…'
$outputDirectoryBrowse.Location = New-Object System.Drawing.Point(376, 175)
$outputDirectoryBrowse.Size = New-Object System.Drawing.Size(84, 34)
$outputDirectoryBrowse.Enabled = -not $outputDirectoryBox.ReadOnly
$directoryPanel.Controls.Add($outputDirectoryBrowse)

$redrawPromptLabel = New-Object System.Windows.Forms.Label
$redrawPromptLabel.Text = '本批次统一重绘要求（必填）'
$redrawPromptLabel.Location = New-Object System.Drawing.Point(2, 218)
$redrawPromptLabel.Size = New-Object System.Drawing.Size(230, 24)
$directoryPanel.Controls.Add($redrawPromptLabel)

$redrawPromptBox = New-Object System.Windows.Forms.TextBox
$redrawPromptBox.Location = New-Object System.Drawing.Point(2, 245)
$redrawPromptBox.Size = New-Object System.Drawing.Size(458, 130)
$redrawPromptBox.Multiline = $true
$redrawPromptBox.AcceptsReturn = $true
$redrawPromptBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
$redrawPromptBox.WordWrap = $true
$redrawPromptBox.Text = if ($savedDirectoryConfiguration) {
  [string]$savedApiConfiguration.RedrawPrompt
} else {
  ''
}
$redrawPromptBox.ReadOnly = $savedDirectoryConfiguration
$directoryPanel.Controls.Add($redrawPromptBox)

$directoryHint = New-Object System.Windows.Forms.Label
$directoryHint.Text = '会递归处理支持的图片；全部结果使用左侧选择的同一比例和尺寸。'
$directoryHint.ForeColor = [System.Drawing.Color]::DimGray
$directoryHint.Location = New-Object System.Drawing.Point(2, 384)
$directoryHint.Size = New-Object System.Drawing.Size(458, 32)
$directoryPanel.Controls.Add($directoryHint)

$selectDirectory = {
  param([System.Windows.Forms.TextBox]$Target, [string]$Description)
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = $Description
  $dialog.ShowNewFolderButton = $true
  $currentPath = ([string]$Target.Text).Trim().Trim('"')
  if ($currentPath -and (Test-Path -LiteralPath $currentPath -PathType Container)) {
    $dialog.SelectedPath = $currentPath
  }
  try {
    if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
      $Target.Text = $dialog.SelectedPath
    }
  } finally {
    $dialog.Dispose()
  }
}
$sourceDirectoryBrowse.Add_Click({ & $selectDirectory $sourceDirectoryBox '选择包含待重绘原图的文件夹' })
$outputDirectoryBrowse.Add_Click({ & $selectDirectory $outputDirectoryBox '选择重绘结果保存文件夹' })

function Add-Label {
  param([string]$Text, [int]$Y)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.Location = New-Object System.Drawing.Point(28, $Y)
  $label.Size = New-Object System.Drawing.Size(100, 26)
  $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $form.Controls.Add($label)
}

function Add-TextBox {
  param([int]$Y, [switch]$Password)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Location = New-Object System.Drawing.Point(140, $Y)
  $box.Size = New-Object System.Drawing.Size(400, 28)
  if ($Password) { $box.UseSystemPasswordChar = $true }
  $form.Controls.Add($box)
  return $box
}

Add-Label '服务地址' 125
$baseUrlBox = Add-TextBox 125
$baseUrlBox.Text = if ($savedApiConfiguration) {
  $savedApiConfiguration.BaseUrl
} elseif ($env:KA_API_BASE_URL) {
  $env:KA_API_BASE_URL
} else {
  'https://canvas.dopamine.video'
}
if ($savedApiConfiguration) { $baseUrlBox.ReadOnly = $true }

Add-Label '登录账号' 165
$usernameBox = Add-TextBox 165
$usernameBox.Text = [string]$env:KA_API_USERNAME

Add-Label '登录密码' 205
$passwordBox = Add-TextBox 205 -Password
$passwordBox.Text = [string]$env:KA_API_PASSWORD

$connectButton = New-Object System.Windows.Forms.Button
$connectButton.Text = '连接并读取项目 / 模型'
$connectButton.Location = New-Object System.Drawing.Point(140, 248)
$connectButton.Size = New-Object System.Drawing.Size(210, 36)
$form.Controls.Add($connectButton)

$connectionStatus = New-Object System.Windows.Forms.Label
$connectionStatus.Text = '尚未连接'
$connectionStatus.Location = New-Object System.Drawing.Point(365, 253)
$connectionStatus.Size = New-Object System.Drawing.Size(175, 28)
$connectionStatus.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$connectionStatus.ForeColor = [System.Drawing.Color]::DarkGoldenrod
$form.Controls.Add($connectionStatus)

Add-Label '目标项目' 302
$projectBox = New-Object System.Windows.Forms.ComboBox
$projectBox.Location = New-Object System.Drawing.Point(140, 302)
$projectBox.Size = New-Object System.Drawing.Size(400, 28)
$projectBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
$projectBox.DisplayMember = 'Text'
$projectBox.Enabled = $false
$form.Controls.Add($projectBox)

Add-Label '生图模型' 342
$modelBox = New-Object System.Windows.Forms.ComboBox
$modelBox.Location = New-Object System.Drawing.Point(140, 342)
$modelBox.Size = New-Object System.Drawing.Size(400, 28)
$modelBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
$modelBox.DisplayMember = 'Text'
$modelBox.Enabled = $false
$form.Controls.Add($modelBox)

Add-Label '并发数量' 393
$workersBox = New-Object System.Windows.Forms.NumericUpDown
$workersBox.Location = New-Object System.Drawing.Point(140, 393)
$workersBox.Size = New-Object System.Drawing.Size(80, 28)
$workersBox.Minimum = 1
$workersBox.Maximum = 16
$requestedWorkers = 2
$parsedWorkers = 0
if ([int]::TryParse([string]$env:KA_API_MAX_WORKERS, [ref]$parsedWorkers)) {
  $requestedWorkers = [Math]::Min(16, [Math]::Max(1, $parsedWorkers))
}
$workersBox.Value = $requestedWorkers
$form.Controls.Add($workersBox)

$ratioLabel = New-Object System.Windows.Forms.Label
$ratioLabel.Text = '画面比例'
$ratioLabel.Location = New-Object System.Drawing.Point(245, 393)
$ratioLabel.Size = New-Object System.Drawing.Size(70, 26)
$ratioLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$form.Controls.Add($ratioLabel)

$ratioBox = New-Object System.Windows.Forms.ComboBox
$ratioBox.Location = New-Object System.Drawing.Point(315, 393)
$ratioBox.Size = New-Object System.Drawing.Size(90, 28)
$ratioBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
[void]$ratioBox.Items.AddRange(@('21:9', '16:9', '5:4', '4:3', '3:2', '1:1', '2:3', '3:4', '4:5', '9:16'))
if ($savedApiConfiguration -and -not $ratioBox.Items.Contains($savedApiConfiguration.AspectRatio)) {
  [void]$ratioBox.Items.Add($savedApiConfiguration.AspectRatio)
}
$requestedRatio = ([string]$env:KA_API_ASPECT_RATIO).Trim()
$ratioBox.SelectedItem = if ($savedApiConfiguration) {
  $savedApiConfiguration.AspectRatio
} elseif ($requestedRatio -and $ratioBox.Items.Contains($requestedRatio)) {
  $requestedRatio
} else {
  '1:1'
}
if ($savedApiConfiguration) { $ratioBox.Enabled = $false }
$form.Controls.Add($ratioBox)

$sizeLabel = New-Object System.Windows.Forms.Label
$sizeLabel.Text = '图片尺寸'
$sizeLabel.Location = New-Object System.Drawing.Point(425, 393)
$sizeLabel.Size = New-Object System.Drawing.Size(70, 26)
$sizeLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$form.Controls.Add($sizeLabel)

$sizeBox = New-Object System.Windows.Forms.ComboBox
$sizeBox.Location = New-Object System.Drawing.Point(495, 393)
$sizeBox.Size = New-Object System.Drawing.Size(60, 28)
$sizeBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
[void]$sizeBox.Items.AddRange(@('1K', '2K'))
if ($savedApiConfiguration -and -not $sizeBox.Items.Contains($savedApiConfiguration.ImageSize)) {
  [void]$sizeBox.Items.Add($savedApiConfiguration.ImageSize)
}
$requestedSize = ([string]$env:KA_API_IMAGE_SIZE).Trim()
$sizeBox.SelectedItem = if ($savedApiConfiguration) {
  $savedApiConfiguration.ImageSize
} elseif ($requestedSize -and $sizeBox.Items.Contains($requestedSize)) {
  $requestedSize
} else {
  '1K'
}
if ($savedApiConfiguration) { $sizeBox.Enabled = $false }
$form.Controls.Add($sizeBox)

$notice = New-Object System.Windows.Forms.Label
$notice.Text = if ($savedApiConfiguration) {
  '检测到当前队列已有 API 进度：服务、项目、模型、比例和尺寸将沿用原配置，避免重复提交。'
} elseif ($isDirectoryRedraw) {
  '开始后只读取所选文件夹、统一重绘要求和 API 参数，不读取 Excel 或资产信息。'
} elseif ($isLegacyReferenceRedraw) {
  '正在恢复旧版参考图重绘批次；其原队列、模板和输出位置保持锁定。'
} else {
  '开始后将自动校验 Excel 与 Cache、建立 API Prompt 队列，并在当前窗口执行批量生成。'
}
$notice.ForeColor = [System.Drawing.Color]::DimGray
$notice.Location = New-Object System.Drawing.Point(28, 434)
$notice.Size = New-Object System.Drawing.Size(520, 38)
$form.Controls.Add($notice)

$footerDivider = New-Object System.Windows.Forms.Label
$footerDivider.BorderStyle = [System.Windows.Forms.BorderStyle]::Fixed3D
$footerDivider.Location = New-Object System.Drawing.Point(24, 478)
$footerDivider.Size = New-Object System.Drawing.Size(1028, 2)
$form.Controls.Add($footerDivider)

$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = if ($isDirectoryRedraw) {
  '开始文件夹批量重绘'
} elseif ($isLegacyReferenceRedraw) {
  '恢复旧版参考图重绘'
} else {
  '开始 API 批量出图'
}
$startButton.Location = New-Object System.Drawing.Point(802, 498)
$startButton.Size = New-Object System.Drawing.Size(168, 40)
$startButton.Enabled = $false
$form.Controls.Add($startButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = '取消'
$cancelButton.Location = New-Object System.Drawing.Point(980, 498)
$cancelButton.Size = New-Object System.Drawing.Size(72, 40)
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancelButton)
$form.CancelButton = $cancelButton

$updateOperationUi = {
  $directoryRedraw = $directoryRedrawCheck.Checked
  $legacyRedraw = $isLegacyReferenceRedraw
  $label = if ($directoryRedraw) {
    'API 文件夹批量重绘'
  } elseif ($legacyRedraw) {
    'API 参考图重绘（旧批次恢复）'
  } else {
    'API 批量出图'
  }
  $form.Text = "Ka - $label"
  $title.Text = "$label 配置"
  $startButton.Text = if ($directoryRedraw) {
    '开始文件夹批量重绘'
  } elseif ($legacyRedraw) {
    '恢复旧版参考图重绘'
  } else {
    '开始 API 批量出图'
  }
  foreach ($control in @($templateTitle, $templateSubtitle, $templateTabs, $templateState)) {
    $control.Visible = -not $directoryRedraw
  }
  $directoryPanel.Visible = $directoryRedraw
  if ($directoryRedraw) { $directoryPanel.BringToFront() }
  if ($modeSelectionLocked) {
    $notice.Text = '检测到需要恢复的 API 批次：任务类型与运行配置已锁定，避免重复提交。'
  } elseif ($directoryRedraw) {
    $notice.Text = '只读取所选文件夹和统一重绘要求；结果保存到用户指定目录，不读取 Excel。'
  } else {
    $notice.Text = '普通生成继续读取 Excel 制作说明与五类模板，并写入标准资产图目录。'
  }
}
$directoryRedrawCheck.Add_CheckedChanged($updateOperationUi)
& $updateOperationUi

$script:configurationLoaded = $false
$invalidateConnection = {
  if ($script:configurationLoaded) {
    $script:configurationLoaded = $false
    $projectBox.Items.Clear()
    $modelBox.Items.Clear()
    $projectBox.Enabled = $false
    $modelBox.Enabled = $false
    $startButton.Enabled = $false
    $connectionStatus.Text = '登录信息已变化，请重新连接'
    $connectionStatus.ForeColor = [System.Drawing.Color]::DarkGoldenrod
  }
}
$savedOperationMatchesUi = {
  if ($null -eq $savedApiConfiguration) { return $false }
  $currentOperation = if ($isLegacyReferenceRedraw) {
    'reference_redraw'
  } elseif ($directoryRedrawCheck.Checked) {
    'directory_redraw'
  } else {
    'generate'
  }
  return [string]$savedApiConfiguration.Operation -ceq $currentOperation
}
$updateApiConfigurationLock = {
  $matchesSavedOperation = & $savedOperationMatchesUi
  if ($matchesSavedOperation) {
    $baseUrlBox.Text = [string]$savedApiConfiguration.BaseUrl
    if ($ratioBox.Items.Contains($savedApiConfiguration.AspectRatio)) {
      $ratioBox.SelectedItem = $savedApiConfiguration.AspectRatio
    }
    if ($sizeBox.Items.Contains($savedApiConfiguration.ImageSize)) {
      $sizeBox.SelectedItem = $savedApiConfiguration.ImageSize
    }
  }
  $baseUrlBox.ReadOnly = $matchesSavedOperation
  $ratioBox.Enabled = -not $matchesSavedOperation
  $sizeBox.Enabled = -not $matchesSavedOperation
}
$baseUrlBox.Add_TextChanged($invalidateConnection)
$usernameBox.Add_TextChanged($invalidateConnection)
$passwordBox.Add_TextChanged($invalidateConnection)
$directoryRedrawCheck.Add_CheckedChanged({
  & $updateApiConfigurationLock
  & $invalidateConnection
})
& $updateApiConfigurationLock

$connectButton.Add_Click({
  $connectButton.Enabled = $false
  $connectionStatus.Text = '正在连接……'
  $connectionStatus.ForeColor = [System.Drawing.Color]::RoyalBlue
  $form.Refresh()
  $previousProxy = $null
  $proxyWasOverridden = $false
  try {
    $baseUrl = Normalize-BaseUrl $baseUrlBox.Text
    $username = $usernameBox.Text.Trim()
    $password = $passwordBox.Text
    if (-not $username -or -not $password) { throw '请输入登录账号和密码。' }

    if (Test-PrivateApiHost $baseUrl) {
      $previousProxy = [Net.WebRequest]::DefaultWebProxy
      [Net.WebRequest]::DefaultWebProxy = [Net.GlobalProxySelection]::GetEmptyWebProxy()
      $proxyWasOverridden = $true
    }

    $loginBody = @{ username = $username; password = $password } | ConvertTo-Json -Compress
    $login = Invoke-Utf8JsonRequest `
      -Method POST `
      -Uri "$baseUrl/api/v1/auth/login" `
      -Headers @{ 'Content-Type' = 'application/json; charset=utf-8' } `
      -Body ([Text.Encoding]::UTF8.GetBytes($loginBody))
    $token = ([string]$login.token).Trim()
    if (-not $token) { throw '登录成功响应中没有 token。' }
    $headers = @{ Authorization = "Bearer $token" }

    $projectResponse = Invoke-Utf8JsonRequest `
      -Method GET `
      -Uri "$baseUrl/api/v1/projects?owner=me" `
      -Headers $headers
    $modelResponse = Invoke-Utf8JsonRequest `
      -Method GET `
      -Uri "$baseUrl/api/v1/models" `
      -Headers $headers

    $projects = Get-CollectionFromResponse $projectResponse @('projects', 'data', 'items')
    $models = Get-CollectionFromResponse $modelResponse @('models', 'data', 'items')
    $imageModels = @($models | Where-Object {
      $capability = $_.capability
      if ($capability -is [Array]) {
        return @($capability) -contains 'image_generation'
      }
      return @(([string]$capability).Split(',') | ForEach-Object { $_.Trim() }) -contains 'image_generation'
    })

    $projectItems = @($projects | ForEach-Object { New-DisplayItem $_ '未命名项目' } | Where-Object { $_ })
    $modelItems = @($imageModels | ForEach-Object { New-DisplayItem $_ '未命名模型' } | Where-Object { $_ })
    if (-not $projectItems.Count) { throw '当前账号没有可用项目，请先在画布平台创建项目。' }
    if (-not $modelItems.Count) { throw '没有找到 capability 包含 image_generation 的模型。' }

    $projectBox.Items.Clear()
    $modelBox.Items.Clear()
    foreach ($item in $projectItems) { [void]$projectBox.Items.Add($item) }
    foreach ($item in $modelItems) { [void]$modelBox.Items.Add($item) }
    $matchesSavedOperation = & $savedOperationMatchesUi
    if ($matchesSavedOperation) {
      if (-not (Select-ComboItemById $projectBox $savedApiConfiguration.ProjectId)) {
        throw "当前账号无法访问待恢复项目：$($savedApiConfiguration.ProjectId)"
      }
      if (-not (Select-ComboItemById $modelBox $savedApiConfiguration.ModelId)) {
        throw "待恢复批次使用的模型当前不可用：$($savedApiConfiguration.ModelId)"
      }
      $projectBox.Enabled = $false
      $modelBox.Enabled = $false
    } else {
      $projectBox.SelectedIndex = 0
      $modelBox.SelectedIndex = 0
      $projectBox.Enabled = $true
      $modelBox.Enabled = $true
    }
    $script:configurationLoaded = $true
    $startButton.Enabled = $true
    $connectionStatus.Text = if ($matchesSavedOperation) {
      '连接成功，已载入原批次配置'
    } else {
      "连接成功：$($projectItems.Count) 个项目，$($modelItems.Count) 个模型"
    }
    $connectionStatus.ForeColor = [System.Drawing.Color]::ForestGreen
  } catch {
    $script:configurationLoaded = $false
    $startButton.Enabled = $false
    $connectionStatus.Text = '连接失败'
    $connectionStatus.ForeColor = [System.Drawing.Color]::Firebrick
    [System.Windows.Forms.MessageBox]::Show(
      $_.Exception.Message,
      '连接失败',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } finally {
    if ($proxyWasOverridden) {
      [Net.WebRequest]::DefaultWebProxy = $previousProxy
    }
    $connectButton.Enabled = $true
    Remove-Variable token, headers, loginBody, login -ErrorAction SilentlyContinue
  }
})

$startButton.Add_Click({
  if (-not $script:configurationLoaded -or $projectBox.SelectedIndex -lt 0 -or $modelBox.SelectedIndex -lt 0) {
    [System.Windows.Forms.MessageBox]::Show(
      '请先连接并选择项目与模型。',
      '尚未完成配置',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    return
  }
  $selectedOperation = if ($isLegacyReferenceRedraw) {
    'reference_redraw'
  } elseif ($directoryRedrawCheck.Checked) {
    'directory_redraw'
  } else {
    'generate'
  }
  $sourceRoot = ''
  $outputRoot = ''
  $redrawPrompt = ''
  if ($selectedOperation -eq 'directory_redraw') {
    try {
      $sourceInput = ([string]$sourceDirectoryBox.Text).Trim().Trim('"')
      $outputInput = ([string]$outputDirectoryBox.Text).Trim().Trim('"')
      $redrawPrompt = Normalize-PromptTemplate ([string]$redrawPromptBox.Text)
      if (-not $sourceInput -or -not $outputInput -or -not $redrawPrompt) {
        throw '原图文件夹、结果保存文件夹和本批次统一重绘要求均为必填。'
      }
      if (-not [IO.Path]::IsPathRooted($sourceInput) -or -not [IO.Path]::IsPathRooted($outputInput)) {
        throw '原图文件夹和结果保存文件夹必须填写完整的绝对路径。'
      }
      $sourceRoot = [IO.Path]::GetFullPath($sourceInput)
      $outputRoot = [IO.Path]::GetFullPath($outputInput)
      if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        throw "原图文件夹不存在：$sourceRoot"
      }
      if (-not (Test-Path -LiteralPath $outputRoot -PathType Container)) {
        throw "结果保存文件夹不存在：$outputRoot"
      }
      if ([string]::Equals($sourceRoot.TrimEnd('\'), $outputRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw '原图文件夹和结果保存文件夹不能是同一个目录。'
      }
      [void](Convert-DirectoryRedrawConfigToBase64 `
        -SourceRoot $sourceRoot `
        -OutputRoot $outputRoot `
        -Prompt $redrawPrompt)
    } catch {
      [System.Windows.Forms.MessageBox]::Show(
        $_.Exception.Message,
        '文件夹批量重绘配置不完整',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      ) | Out-Null
      return
    }
  }
  $promptTemplates = $null
  if ($selectedOperation -ne 'directory_redraw' -and (-not $templatesLocked -or $savedTemplatesAvailable)) {
    $values = [ordered]@{}
    foreach ($sheetName in $sheetOrder) {
      $values[$sheetName] = Normalize-PromptTemplate $templateBoxes[$sheetName].Text
    }
    $promptTemplates = [pscustomobject]$values
  }
  $form.Tag = [ordered]@{
    Operation = $selectedOperation
    BaseUrl = Normalize-BaseUrl $baseUrlBox.Text
    Username = $usernameBox.Text.Trim()
    Password = $passwordBox.Text
    ProjectId = ([string]$projectBox.SelectedItem.Id).Trim()
    ModelId = ([string]$modelBox.SelectedItem.Id).Trim()
    MaxWorkers = [int]$workersBox.Value
    AspectRatio = [string]$ratioBox.SelectedItem
    ImageSize = [string]$sizeBox.SelectedItem
    PromptTemplates = $promptTemplates
    LegacyPromptQueue = ($selectedOperation -eq 'reference_redraw' -and $templatesLocked -and -not $savedTemplatesAvailable)
    SourceRoot = $sourceRoot
    OutputRoot = $outputRoot
    RedrawPrompt = $redrawPrompt
  }
  $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Close()
})

$form.AcceptButton = $startButton
$script:consoleWasHiddenForApiWindow = $false
$form.Add_Shown({
  $form.Activate()
  $form.Refresh()
  $script:consoleWasHiddenForApiWindow = Hide-KaConsole
  if (
    -not $script:configurationLoaded -and
    -not [string]::IsNullOrWhiteSpace($usernameBox.Text) -and
    -not [string]::IsNullOrWhiteSpace($passwordBox.Text)
  ) {
    $connectButton.PerformClick()
  }
})
try {
  $dialogResult = $form.ShowDialog()
} catch {
  if ($script:consoleWasHiddenForApiWindow) { Show-KaConsole }
  throw
}
$consoleWasHidden = $script:consoleWasHiddenForApiWindow
Remove-Variable consoleWasHiddenForApiWindow -Scope Script -ErrorAction SilentlyContinue
if ($dialogResult -ne [System.Windows.Forms.DialogResult]::OK -or -not $form.Tag) {
  $form.Dispose()
  exit 2
}
$settings = $form.Tag
$passwordBox.Text = ''
$form.Dispose()
if ($consoleWasHidden) { Show-KaConsole }
}
$Operation = [string]$settings.Operation
$isDirectoryRedraw = $Operation -eq 'directory_redraw'
$isLegacyReferenceRedraw = $Operation -eq 'reference_redraw'
$operationTitle = if ($isDirectoryRedraw) {
  'API 文件夹批量重绘'
} elseif ($isLegacyReferenceRedraw) {
  'API 参考图重绘（旧批次恢复）'
} else {
  'API 批量出图'
}
if ($OnlyQueueKey -and $Operation -cne 'generate') {
  throw '资产队列 Key 单项模式只适用于普通 API 资产出图。'
}
try { $Host.UI.RawUI.WindowTitle = "Ka - $operationTitle 任务" } catch {}

$apiExecutionVariableNames = @(
  'KA_API_BASE_URL', 'KA_API_USERNAME', 'KA_API_PASSWORD', 'KA_API_PROJECT_ID',
  'KA_API_MODEL_ID', 'KA_API_MAX_WORKERS', 'KA_API_ASPECT_RATIO', 'KA_API_IMAGE_SIZE'
)
$queueConfigVariableNames = @(
  'KA_API_PROMPT_TEMPLATES_B64', 'KA_REDRAW_CONFIG_B64'
)
$variableNames = @($apiExecutionVariableNames + $queueConfigVariableNames)
$previousEnvironment = @{}
foreach ($name in $variableNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$exitCode = 1
try {
  # Environment checks and Node queue builders do not need API credentials.
  # Clear inherited values as well as values entered in this window.
  foreach ($name in $variableNames) {
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
  }

  Write-Host '正在检查运行环境，请稍候……' -ForegroundColor Cyan
  if ($isDirectoryRedraw) {
    & $environmentCheck -ApiOnly
  } else {
    & $environmentCheck
  }
  if ($LASTEXITCODE -ne 0) {
    throw "运行环境检查失败，退出码：$LASTEXITCODE"
  }

  if ($isDirectoryRedraw) {
    Remove-Item Env:KA_API_PROMPT_TEMPLATES_B64 -ErrorAction SilentlyContinue
    $env:KA_REDRAW_CONFIG_B64 = Convert-DirectoryRedrawConfigToBase64 `
      -SourceRoot $settings.SourceRoot `
      -OutputRoot $settings.OutputRoot `
      -Prompt $settings.RedrawPrompt
  } elseif ($null -ne $settings.PromptTemplates) {
    Remove-Item Env:KA_REDRAW_CONFIG_B64 -ErrorAction SilentlyContinue
    $env:KA_API_PROMPT_TEMPLATES_B64 = Convert-ApiPromptTemplatesToBase64 -Templates $settings.PromptTemplates
  } else {
    Remove-Item Env:KA_REDRAW_CONFIG_B64 -ErrorAction SilentlyContinue
    Remove-Item Env:KA_API_PROMPT_TEMPLATES_B64 -ErrorAction SilentlyContinue
  }

  $resume = $false
  if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
    $lock = Read-PipelineLockFile -Path $lockPath
    if ([string]$lock.kind -ceq 'queue_build') {
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
      Write-Host '已清理上次异常中断遗留的建队锁，将重新校验并建立队列。' -ForegroundColor Yellow
    } elseif ([string]$lock.kind -cne 'image_generation_batch') {
      throw "其他流水线任务正在运行：$($lock.kind):$($lock.key)"
    } else {
      $lockedOperation = ([string]$lock.operation).Trim()
      if (-not $lockedOperation -and [string]$lock.key -ceq 'directory_redraw') {
        $lockedOperation = 'directory_redraw'
      }
      if ($lockedOperation -and $lockedOperation -cne $Operation) {
        throw "恢复锁属于 $lockedOperation，当前窗口选择的是 $Operation，禁止混用任务状态。"
      }
      if (-not $lockedOperation -and $isDirectoryRedraw) {
        throw '旧版 API 恢复锁没有任务类型，不能安全地作为文件夹批量重绘恢复。'
      }
      $answer = [System.Windows.Forms.MessageBox]::Show(
        "发现上次 API 批次留下的恢复锁。`n`n只有确认旧的 API 出图窗口已经关闭，才可继续恢复。",
        '恢复上次 API 批次',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      )
      if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
        Write-Host '已取消恢复，未修改任务状态。' -ForegroundColor Yellow
        exit 2
      }
      $resume = $true
    }
  }

  $activeRemote = $false
  $selectedProgressPath = if ($isDirectoryRedraw) { $directoryRedrawProgressPath } else { $progressPath }
  if (-not $resume -and (Test-Path -LiteralPath $selectedProgressPath -PathType Leaf)) {
    try {
      $progress = Get-Content -LiteralPath $selectedProgressPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -ne $progress.items) {
        if ($isDirectoryRedraw) {
          foreach ($property in $progress.items.PSObject.Properties) {
            if (
              [string]$property.Value.backend -ceq 'api' -and
              [string]$property.Value.status -ceq 'generating'
            ) {
              $activeRemote = $true
              break
            }
          }
        } else {
          if (-not (Test-Path -LiteralPath $queuePath -PathType Leaf)) {
            throw "出图队列不存在：$queuePath"
          }
          $currentQueue = Get-Content -LiteralPath $queuePath -Raw -Encoding UTF8 | ConvertFrom-Json
          $activeRemote = Test-ActiveAssetApiGeneration -Queue $currentQueue -Progress $progress
        }
      }
    } catch {
      throw "出图进度无法读取，禁止在未知状态下建立新队列：$selectedProgressPath"
    }
  }

  if ($isDirectoryRedraw) {
    if (-not $resume -and -not $activeRemote) {
      Write-Host '正在扫描原图文件夹并建立独立的批量重绘队列……' -ForegroundColor Cyan
      & $nodeRunner $directoryRedrawQueueBuilder $skillRoot
      if ($LASTEXITCODE -ne 0) { throw "文件夹批量重绘队列建立失败，退出码：$LASTEXITCODE" }
      $newRedrawQueue = Get-Content -LiteralPath $directoryRedrawQueuePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $newRedrawTotal = @($newRedrawQueue.items).Count
      if ($newRedrawTotal -ge 100) {
        $confirmLargeBatch = [Windows.Forms.MessageBox]::Show(
          "本批次将向远端 API 提交 $newRedrawTotal 张图片。大批量任务可能产生较高费用和较长运行时间。`r`n`r`n是否确认继续？",
          '确认大批量远端重绘',
          [Windows.Forms.MessageBoxButtons]::YesNo,
          [Windows.Forms.MessageBoxIcon]::Warning,
          [Windows.Forms.MessageBoxDefaultButton]::Button2
        )
        if ($confirmLargeBatch -ne [Windows.Forms.DialogResult]::Yes) {
          throw '用户已取消大批量远端重绘；队列已保留，但尚未启动 API。'
        }
      }
    } else {
      Write-Host '检测到待恢复的文件夹批量重绘任务，将沿用原目录、统一要求和任务 ID。' -ForegroundColor Yellow
    }
  } elseif ($settings.LegacyPromptQueue) {
    Write-Host '旧版 API 队列没有模板快照，将原样沿用队列中已保存的 Prompt。' -ForegroundColor Yellow
  } elseif (-not $resume -and -not $activeRemote) {
    if ($null -eq $settings.PromptTemplates) {
      throw '旧批次没有可迁移的提示词模板，禁止按新规则重建；请先恢复原任务，或在确认不再需要旧任务后清空 Cache。'
    }
    $queueAction = if ($isLegacyReferenceRedraw) { '参考图重绘' } else { '出图' }
    Write-Host "正在校验 Excel 并建立 API $queueAction 队列……" -ForegroundColor Cyan
    $queueArguments = @($queueBuilder, $skillRoot, '--api-prompts-env')
    if ($isLegacyReferenceRedraw) { $queueArguments += '--reference-redraw' }
    & $nodeRunner @queueArguments
    if ($LASTEXITCODE -ne 0) { throw "出图队列建立失败，退出码：$LASTEXITCODE" }
  } else {
    Write-Host '检测到待恢复的 API 任务，将沿用原队列和任务 ID。' -ForegroundColor Yellow
  }

  Write-Host "开始 $operationTitle。请保留此窗口，详细进度可在只读进度窗口查看。" -ForegroundColor Cyan
  $batchArguments = @($batchRunner, $skillRoot)
  if ($isDirectoryRedraw) { $batchArguments += '--directory-redraw' }
  if ($resume) { $batchArguments += '--resume' }
  if ($OnlyQueueKey) {
    Write-Host "本次仅生成：$OnlyQueueKey" -ForegroundColor Yellow
    $batchArguments += @('--only-key', $OnlyQueueKey)
  }

  foreach ($name in $queueConfigVariableNames) {
    Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
  }
  $env:KA_API_BASE_URL = $settings.BaseUrl
  $env:KA_API_USERNAME = $settings.Username
  $env:KA_API_PASSWORD = $settings.Password
  $env:KA_API_PROJECT_ID = $settings.ProjectId
  $env:KA_API_MODEL_ID = $settings.ModelId
  $env:KA_API_MAX_WORKERS = [string]$settings.MaxWorkers
  $env:KA_API_ASPECT_RATIO = $settings.AspectRatio
  $env:KA_API_IMAGE_SIZE = $settings.ImageSize
  & $pythonRunner @batchArguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    Write-Host "$operationTitle 已完成。" -ForegroundColor Green
  } else {
    Write-Host "$operationTitle 未完全完成，退出码：$exitCode。请查看进度窗口中的失败项。" -ForegroundColor Red
  }
} finally {
  foreach ($name in $variableNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
  $settings.Password = $null
  Remove-Variable settings -ErrorAction SilentlyContinue
}

exit $exitCode
