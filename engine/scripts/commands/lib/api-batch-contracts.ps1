# Network, prompt-template, and shared UI contracts for start_api_batch.ps1.

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
