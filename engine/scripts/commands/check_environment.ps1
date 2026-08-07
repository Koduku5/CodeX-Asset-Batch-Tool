[CmdletBinding()]
param(
  [switch]$NoInstall,
  [switch]$InstallMissing,
  [switch]$ApiOnly
)

$ErrorActionPreference = 'Stop'
$installModeCount = [int]$NoInstall.IsPresent + [int]$InstallMissing.IsPresent
if ($installModeCount -gt 1) {
  throw '-NoInstall and -InstallMissing cannot be used together.'
}
$utf8 = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8
try { [Console]::InputEncoding = $utf8 } catch {}
try { [Console]::OutputEncoding = $utf8 } catch {}
chcp.com 65001 | Out-Null

$skillRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$nodeRunner = Join-Path $PSScriptRoot 'node.ps1'
$pythonRunner = Join-Path $PSScriptRoot 'python.ps1'

function Invoke-Checked {
  param(
    [string]$Executable,
    [string[]]$Arguments,
    [string]$FailureMessage
  )
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $Executable @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) {
    $detail = ($output | Out-String).Trim()
    if ($detail) { throw "$FailureMessage`n$detail" }
    throw $FailureMessage
  }
  return @($output)
}

$powerShellVersion = $PSVersionTable.PSVersion
if ($powerShellVersion -lt [version]'5.1') {
  throw "Windows PowerShell 5.1 or later is required. Found: $powerShellVersion"
}
Write-Host "[OK] PowerShell $powerShellVersion"

if (-not (Test-Path -LiteralPath $nodeRunner -PathType Leaf)) {
  throw "Node.js runtime wrapper is missing: $nodeRunner"
}
$nodeVersionText = (Invoke-Checked -Executable $nodeRunner -Arguments @('--version') -FailureMessage 'Node.js failed to start.' | Select-Object -First 1).ToString().Trim()
$nodeVersion = [version]$nodeVersionText.TrimStart('v')
if ($nodeVersion.Major -lt 18) {
  throw "Node.js 18 or later is required. Found: $nodeVersionText"
}
Write-Host "[OK] Node.js $nodeVersionText"

if (-not $ApiOnly) {
  $nodeCheckPath = Join-Path $PSScriptRoot 'check_node_environment.mjs'
  try {
    Invoke-Checked -Executable $nodeRunner -Arguments @($nodeCheckPath, $skillRoot) -FailureMessage 'Codex spreadsheet dependency or Excel template smoke test failed.' | Out-Null
  } catch {
    throw "$($_.Exception.Message)`nUse the Codex Desktop bundled runtime; this dependency is not installed automatically from npm."
  }
  Write-Host '[OK] @oai/artifact-tool'
}

if (-not (Test-Path -LiteralPath $pythonRunner -PathType Leaf)) {
  throw "Python runtime wrapper is missing: $pythonRunner"
}
$pythonVersion = (Invoke-Checked -Executable $pythonRunner -Arguments @('-c', 'import sys; print(sys.version.split()[0])') -FailureMessage 'Python failed to start.' | Select-Object -First 1).ToString().Trim()
if ([version]$pythonVersion -lt [version]'3.10') {
  throw "Python 3.10 or later is required. Found: $pythonVersion"
}
Write-Host "[OK] Python $pythonVersion"

$unicodeProbe = '"\u4e2d\u6587\u8def\u5f84\u2713"' | ConvertFrom-Json
$nodeProbe = (
  Invoke-Checked `
    -Executable $nodeRunner `
    -Arguments @('-e', 'process.stdout.write(process.argv[1])', $unicodeProbe) `
    -FailureMessage 'Node.js UTF-8 argument round-trip failed.' |
  Select-Object -First 1
).ToString()
if ($nodeProbe -cne $unicodeProbe) {
  throw 'Node.js UTF-8 argument/output round-trip failed.'
}
$pythonProbe = (
  Invoke-Checked `
    -Executable $pythonRunner `
    -Arguments @('-c', 'import sys; sys.stdout.write(sys.argv[1])', $unicodeProbe) `
    -FailureMessage 'Python UTF-8 argument round-trip failed.' |
  Select-Object -First 1
).ToString()
if ($pythonProbe -cne $unicodeProbe) {
  throw 'Python UTF-8 argument/output round-trip failed.'
}
Write-Host '[OK] UTF-8 command arguments and output'

if (-not $ApiOnly) {
  $docxCheck = 'import docx; assert tuple(map(int,docx.__version__.split(chr(46))[:2])) >= (1,2), docx.__version__; assert callable(docx.Document().iter_inner_content); print(docx.__version__)'
  $docxVersion = $null
  try {
    $docxVersion = (Invoke-Checked -Executable $pythonRunner -Arguments @('-c', $docxCheck) -FailureMessage 'python-docx is missing or too old.' | Select-Object -First 1).ToString().Trim()
  } catch {
    if (-not $InstallMissing) {
      $noInstallDetail = if ($NoInstall) { '-NoInstall was specified, so no package was installed.' } else { 'No package was installed.' }
      throw "$($_.Exception.Message)`n$noInstallDetail After reviewing the command, run this check again with -InstallMissing to install python-docx==1.2.0 for the selected Python runtime."
    }
    Write-Host '[FIX] Explicitly authorized: installing python-docx 1.2.0 for the selected Python runtime...' -ForegroundColor Yellow
    Invoke-Checked -Executable $pythonRunner -Arguments @('-m', 'pip', 'install', '--user', '--disable-pip-version-check', 'python-docx==1.2.0') -FailureMessage 'Automatic python-docx installation failed.' | Out-Null
    $docxVersion = (Invoke-Checked -Executable $pythonRunner -Arguments @('-c', $docxCheck) -FailureMessage 'python-docx is still unavailable after installation.' | Select-Object -First 1).ToString().Trim()
  }
  Write-Host "[OK] python-docx $docxVersion"

  $pillowRequirement = 'Pillow==12.2.0'
  $pillowCheck = "import io, PIL; from PIL import Image, features; assert features.check('webp'), 'Pillow WebP codec unavailable'; probe=io.BytesIO(); Image.new('RGBA', (2,1), (17,34,51,255)).save(probe, format='WEBP', lossless=True); probe.seek(0); decoded=Image.open(probe); assert decoded.format == 'WEBP', decoded.format; decoded.load(); assert decoded.size == (2,1), decoded.size; assert decoded.convert('RGBA').getpixel((0,0)) == (17,34,51,255); print(PIL.__version__)"
  $pillowVersion = $null
  try {
    $pillowVersion = (Invoke-Checked -Executable $pythonRunner -Arguments @('-c', $pillowCheck) -FailureMessage 'Pillow is missing, or its WebP encoder/decoder is unavailable.' | Select-Object -First 1).ToString().Trim()
  } catch {
    if (-not $InstallMissing) {
      $noInstallDetail = if ($NoInstall) { '-NoInstall was specified, so no package was installed.' } else { 'No package was installed.' }
      throw "$($_.Exception.Message)`n$noInstallDetail After reviewing the command, run this check again with -InstallMissing to install $pillowRequirement for the selected Python runtime."
    }
    Write-Host "[FIX] Explicitly authorized: installing $pillowRequirement for the selected Python runtime..." -ForegroundColor Yellow
    Invoke-Checked `
      -Executable $pythonRunner `
      -Arguments @('-m', 'pip', 'install', '--user', '--disable-pip-version-check', $pillowRequirement) `
      -FailureMessage "Automatic $pillowRequirement installation failed. Check network access and whether pip can install a Windows wheel for the selected Python runtime." |
      Out-Null
    $pillowVersion = (
      Invoke-Checked `
        -Executable $pythonRunner `
        -Arguments @('-c', $pillowCheck) `
        -FailureMessage 'Pillow is still unavailable or its WebP encoder/decoder is missing after installation. Verify that the selected Python runtime can load a Pillow Windows wheel with WebP support.' |
      Select-Object -First 1
    ).ToString().Trim()
  }
  Write-Host "[OK] Pillow $pillowVersion (WebP encode/decode)"
}

Write-Host '[INFO] Built-in image_gen is checked when used. API batch generation and folder redraw validate credentials only when started.'
Write-Host ''
Write-Host 'Environment check passed.' -ForegroundColor Green
Write-Host "Skill root: $skillRoot"
