# Headless settings and WinForms configuration for start_api_batch.ps1.

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

$settings = if ($Headless) {
  Get-ApiBatchHeadlessSettings
} else {
  Show-ApiBatchConfigurationDialog
}
