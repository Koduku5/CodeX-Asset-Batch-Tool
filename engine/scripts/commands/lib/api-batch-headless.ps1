function Get-ApiBatchHeadlessSettings {
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
  return $settings
}

