# Queue preparation, execution, and cleanup for start_api_batch.ps1.

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
