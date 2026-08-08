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
  return $settings
}

