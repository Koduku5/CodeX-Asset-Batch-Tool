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

$apiBatchLibraryRoot = Join-Path $PSScriptRoot 'lib'
$apiBatchLibraries = @(
  (Join-Path $apiBatchLibraryRoot 'api-batch-contracts.ps1'),
  (Join-Path $apiBatchLibraryRoot 'api-batch-state.ps1'),
  (Join-Path $apiBatchLibraryRoot 'api-batch-headless.ps1'),
  (Join-Path $apiBatchLibraryRoot 'api-batch-dialog.ps1'),
  (Join-Path $apiBatchLibraryRoot 'api-batch-form.ps1'),
  (Join-Path $apiBatchLibraryRoot 'api-batch-launch.ps1')
)
foreach ($libraryPath in $apiBatchLibraries) {
  if (-not (Test-Path -LiteralPath $libraryPath -PathType Leaf)) {
    throw "缺少 API 批量出图命令库：$libraryPath"
  }
  . $libraryPath
}
