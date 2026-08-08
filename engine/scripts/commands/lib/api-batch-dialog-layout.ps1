function New-ApiBatchPromptControls {
  param(
    [System.Windows.Forms.Form]$Form,
    [bool]$IsDirectoryRedraw,
    $SavedApiConfiguration,
    $DefaultApiPromptTemplates,
    [string[]]$SheetOrder
  )

  $verticalDivider = New-Object System.Windows.Forms.Label
  $verticalDivider.BorderStyle = [System.Windows.Forms.BorderStyle]::Fixed3D
  $verticalDivider.Location = New-Object System.Drawing.Point(565, 20)
  $verticalDivider.Size = New-Object System.Drawing.Size(2, 440)
  $Form.Controls.Add($verticalDivider)

  $templateTitle = New-Object System.Windows.Forms.Label
  $templateTitle.Text = 'API 提示词模板'
  $templateTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Bold)
  $templateTitle.Location = New-Object System.Drawing.Point(590, 20)
  $templateTitle.AutoSize = $true
  $Form.Controls.Add($templateTitle)

  $templateSubtitle = New-Object System.Windows.Forms.Label
  $templateSubtitle.Text = '最终 Prompt = 当前分类模板 + Excel“制作说明”。模板可修改或留空，不再读取外部前缀和风格文件。'
  $templateSubtitle.ForeColor = [System.Drawing.Color]::DimGray
  $templateSubtitle.Location = New-Object System.Drawing.Point(592, 58)
  $templateSubtitle.Size = New-Object System.Drawing.Size(460, 38)
  $Form.Controls.Add($templateSubtitle)

  $templateTabs = New-Object System.Windows.Forms.TabControl
  $templateTabs.Location = New-Object System.Drawing.Point(590, 100)
  $templateTabs.Size = New-Object System.Drawing.Size(462, 270)
  $templateTabs.SizeMode = [System.Windows.Forms.TabSizeMode]::Fixed
  $templateTabs.ItemSize = New-Object System.Drawing.Size(86, 30)
  $Form.Controls.Add($templateTabs)

  $templateBoxes = @{}
  $templatesLocked = ($null -ne $SavedApiConfiguration)
  $savedTemplatesAvailable = (
    $templatesLocked -and
    [bool]$SavedApiConfiguration.PromptTemplatesAvailable -and
    (Test-ApiPromptTemplates -Templates $SavedApiConfiguration.PromptTemplates)
  )
  $initialTemplates = if ($savedTemplatesAvailable) {
    $SavedApiConfiguration.PromptTemplates
  } else {
    $DefaultApiPromptTemplates
  }
  foreach ($sheetName in $SheetOrder) {
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
  $Form.Controls.Add($templateState)

  $directoryPanel = New-Object System.Windows.Forms.Panel
  $directoryPanel.Location = New-Object System.Drawing.Point(590, 18)
  $directoryPanel.Size = New-Object System.Drawing.Size(462, 420)
  $directoryPanel.Visible = $IsDirectoryRedraw
  $Form.Controls.Add($directoryPanel)

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
    $IsDirectoryRedraw -and
    $null -ne $SavedApiConfiguration -and
    [string]$SavedApiConfiguration.Operation -ceq 'directory_redraw'
  )
  $sourceDirectoryBox.Text = if ($savedDirectoryConfiguration) {
    [string]$SavedApiConfiguration.SourceRoot
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
    [string]$SavedApiConfiguration.OutputRoot
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
    [string]$SavedApiConfiguration.RedrawPrompt
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

  return [pscustomobject]@{
    TemplateTitle = $templateTitle
    TemplateSubtitle = $templateSubtitle
    TemplateTabs = $templateTabs
    TemplateState = $templateState
    TemplateBoxes = $templateBoxes
    TemplatesLocked = $templatesLocked
    SavedTemplatesAvailable = $savedTemplatesAvailable
    DirectoryPanel = $directoryPanel
    SourceDirectoryBox = $sourceDirectoryBox
    SourceDirectoryBrowse = $sourceDirectoryBrowse
    OutputDirectoryBox = $outputDirectoryBox
    OutputDirectoryBrowse = $outputDirectoryBrowse
    RedrawPromptBox = $redrawPromptBox
  }
}

function New-ApiBatchConnectionControls {
  param(
    [System.Windows.Forms.Form]$Form,
    [bool]$IsDirectoryRedraw,
    [bool]$IsLegacyReferenceRedraw,
    $SavedApiConfiguration
  )

  function Add-Label {
    param([string]$Text, [int]$Y)
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Text
    $label.Location = New-Object System.Drawing.Point(28, $Y)
    $label.Size = New-Object System.Drawing.Size(100, 26)
    $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
    $Form.Controls.Add($label)
  }

  function Add-TextBox {
    param([int]$Y, [switch]$Password)
    $box = New-Object System.Windows.Forms.TextBox
    $box.Location = New-Object System.Drawing.Point(140, $Y)
    $box.Size = New-Object System.Drawing.Size(400, 28)
    if ($Password) { $box.UseSystemPasswordChar = $true }
    $Form.Controls.Add($box)
    return $box
  }

  Add-Label '服务地址' 125
  $baseUrlBox = Add-TextBox 125
  $baseUrlBox.Text = if ($SavedApiConfiguration) {
    $SavedApiConfiguration.BaseUrl
  } elseif ($env:KA_API_BASE_URL) {
    $env:KA_API_BASE_URL
  } else {
    'https://canvas.dopamine.video'
  }
  if ($SavedApiConfiguration) { $baseUrlBox.ReadOnly = $true }

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
  $Form.Controls.Add($connectButton)

  $connectionStatus = New-Object System.Windows.Forms.Label
  $connectionStatus.Text = '尚未连接'
  $connectionStatus.Location = New-Object System.Drawing.Point(365, 253)
  $connectionStatus.Size = New-Object System.Drawing.Size(175, 28)
  $connectionStatus.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $connectionStatus.ForeColor = [System.Drawing.Color]::DarkGoldenrod
  $Form.Controls.Add($connectionStatus)

  Add-Label '目标项目' 302
  $projectBox = New-Object System.Windows.Forms.ComboBox
  $projectBox.Location = New-Object System.Drawing.Point(140, 302)
  $projectBox.Size = New-Object System.Drawing.Size(400, 28)
  $projectBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  $projectBox.DisplayMember = 'Text'
  $projectBox.Enabled = $false
  $Form.Controls.Add($projectBox)

  Add-Label '生图模型' 342
  $modelBox = New-Object System.Windows.Forms.ComboBox
  $modelBox.Location = New-Object System.Drawing.Point(140, 342)
  $modelBox.Size = New-Object System.Drawing.Size(400, 28)
  $modelBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  $modelBox.DisplayMember = 'Text'
  $modelBox.Enabled = $false
  $Form.Controls.Add($modelBox)

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
  $Form.Controls.Add($workersBox)

  $ratioLabel = New-Object System.Windows.Forms.Label
  $ratioLabel.Text = '画面比例'
  $ratioLabel.Location = New-Object System.Drawing.Point(245, 393)
  $ratioLabel.Size = New-Object System.Drawing.Size(70, 26)
  $ratioLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $Form.Controls.Add($ratioLabel)

  $ratioBox = New-Object System.Windows.Forms.ComboBox
  $ratioBox.Location = New-Object System.Drawing.Point(315, 393)
  $ratioBox.Size = New-Object System.Drawing.Size(90, 28)
  $ratioBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  [void]$ratioBox.Items.AddRange(@('21:9', '16:9', '5:4', '4:3', '3:2', '1:1', '2:3', '3:4', '4:5', '9:16'))
  if ($SavedApiConfiguration -and -not $ratioBox.Items.Contains($SavedApiConfiguration.AspectRatio)) {
    [void]$ratioBox.Items.Add($SavedApiConfiguration.AspectRatio)
  }
  $requestedRatio = ([string]$env:KA_API_ASPECT_RATIO).Trim()
  $ratioBox.SelectedItem = if ($SavedApiConfiguration) {
    $SavedApiConfiguration.AspectRatio
  } elseif ($requestedRatio -and $ratioBox.Items.Contains($requestedRatio)) {
    $requestedRatio
  } else {
    '1:1'
  }
  if ($SavedApiConfiguration) { $ratioBox.Enabled = $false }
  $Form.Controls.Add($ratioBox)

  $sizeLabel = New-Object System.Windows.Forms.Label
  $sizeLabel.Text = '图片尺寸'
  $sizeLabel.Location = New-Object System.Drawing.Point(425, 393)
  $sizeLabel.Size = New-Object System.Drawing.Size(70, 26)
  $sizeLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $Form.Controls.Add($sizeLabel)

  $sizeBox = New-Object System.Windows.Forms.ComboBox
  $sizeBox.Location = New-Object System.Drawing.Point(495, 393)
  $sizeBox.Size = New-Object System.Drawing.Size(60, 28)
  $sizeBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  [void]$sizeBox.Items.AddRange(@('1K', '2K'))
  if ($SavedApiConfiguration -and -not $sizeBox.Items.Contains($SavedApiConfiguration.ImageSize)) {
    [void]$sizeBox.Items.Add($SavedApiConfiguration.ImageSize)
  }
  $requestedSize = ([string]$env:KA_API_IMAGE_SIZE).Trim()
  $sizeBox.SelectedItem = if ($SavedApiConfiguration) {
    $SavedApiConfiguration.ImageSize
  } elseif ($requestedSize -and $sizeBox.Items.Contains($requestedSize)) {
    $requestedSize
  } else {
    '1K'
  }
  if ($SavedApiConfiguration) { $sizeBox.Enabled = $false }
  $Form.Controls.Add($sizeBox)

  $notice = New-Object System.Windows.Forms.Label
  $notice.Text = if ($SavedApiConfiguration) {
    '检测到当前队列已有 API 进度：服务、项目、模型、比例和尺寸将沿用原配置，避免重复提交。'
  } elseif ($IsDirectoryRedraw) {
    '开始后只读取所选文件夹、统一重绘要求和 API 参数，不读取 Excel 或资产信息。'
  } elseif ($IsLegacyReferenceRedraw) {
    '正在恢复旧版参考图重绘批次；其原队列、模板和输出位置保持锁定。'
  } else {
    '开始后将自动校验 Excel 与 Cache、建立 API Prompt 队列，并在当前窗口执行批量生成。'
  }
  $notice.ForeColor = [System.Drawing.Color]::DimGray
  $notice.Location = New-Object System.Drawing.Point(28, 434)
  $notice.Size = New-Object System.Drawing.Size(520, 38)
  $Form.Controls.Add($notice)

  $footerDivider = New-Object System.Windows.Forms.Label
  $footerDivider.BorderStyle = [System.Windows.Forms.BorderStyle]::Fixed3D
  $footerDivider.Location = New-Object System.Drawing.Point(24, 478)
  $footerDivider.Size = New-Object System.Drawing.Size(1028, 2)
  $Form.Controls.Add($footerDivider)

  $startButton = New-Object System.Windows.Forms.Button
  $startButton.Text = if ($IsDirectoryRedraw) {
    '开始文件夹批量重绘'
  } elseif ($IsLegacyReferenceRedraw) {
    '恢复旧版参考图重绘'
  } else {
    '开始 API 批量出图'
  }
  $startButton.Location = New-Object System.Drawing.Point(802, 498)
  $startButton.Size = New-Object System.Drawing.Size(168, 40)
  $startButton.Enabled = $false
  $Form.Controls.Add($startButton)

  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Text = '取消'
  $cancelButton.Location = New-Object System.Drawing.Point(980, 498)
  $cancelButton.Size = New-Object System.Drawing.Size(72, 40)
  $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $Form.Controls.Add($cancelButton)
  $Form.CancelButton = $cancelButton

  return [pscustomobject]@{
    BaseUrlBox = $baseUrlBox
    UsernameBox = $usernameBox
    PasswordBox = $passwordBox
    ConnectButton = $connectButton
    ConnectionStatus = $connectionStatus
    ProjectBox = $projectBox
    ModelBox = $modelBox
    WorkersBox = $workersBox
    RatioBox = $ratioBox
    SizeBox = $sizeBox
    Notice = $notice
    StartButton = $startButton
    CancelButton = $cancelButton
  }
}
