function Show-ApiBatchConfigurationDialog {
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

  $promptControls = New-ApiBatchPromptControls `
    -Form $form `
    -IsDirectoryRedraw $isDirectoryRedraw `
    -SavedApiConfiguration $savedApiConfiguration `
    -DefaultApiPromptTemplates $defaultApiPromptTemplates `
    -SheetOrder $sheetOrder
  $templateTitle = $promptControls.TemplateTitle
  $templateSubtitle = $promptControls.TemplateSubtitle
  $templateTabs = $promptControls.TemplateTabs
  $templateState = $promptControls.TemplateState
  $templateBoxes = $promptControls.TemplateBoxes
  $templatesLocked = $promptControls.TemplatesLocked
  $savedTemplatesAvailable = $promptControls.SavedTemplatesAvailable
  $directoryPanel = $promptControls.DirectoryPanel
  $sourceDirectoryBox = $promptControls.SourceDirectoryBox
  $sourceDirectoryBrowse = $promptControls.SourceDirectoryBrowse
  $outputDirectoryBox = $promptControls.OutputDirectoryBox
  $outputDirectoryBrowse = $promptControls.OutputDirectoryBrowse
  $redrawPromptBox = $promptControls.RedrawPromptBox

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

  $connectionControls = New-ApiBatchConnectionControls `
    -Form $form `
    -IsDirectoryRedraw $isDirectoryRedraw `
    -IsLegacyReferenceRedraw $isLegacyReferenceRedraw `
    -SavedApiConfiguration $savedApiConfiguration
  $baseUrlBox = $connectionControls.BaseUrlBox
  $usernameBox = $connectionControls.UsernameBox
  $passwordBox = $connectionControls.PasswordBox
  $connectButton = $connectionControls.ConnectButton
  $connectionStatus = $connectionControls.ConnectionStatus
  $projectBox = $connectionControls.ProjectBox
  $modelBox = $connectionControls.ModelBox
  $workersBox = $connectionControls.WorkersBox
  $ratioBox = $connectionControls.RatioBox
  $sizeBox = $connectionControls.SizeBox
  $notice = $connectionControls.Notice
  $startButton = $connectionControls.StartButton

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
  return $settings
}
