[CmdletBinding()]
param(
    [switch]$SkipChecks,
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content (Join-Path $sourceRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = [string]$package.version }

Push-Location $sourceRoot
try {
    if (-not $SkipChecks) {
        & npm.cmd run check
        if ($LASTEXITCODE -ne 0) { throw "Full verification failed with exit code $LASTEXITCODE" }
    }
    & (Join-Path $PSScriptRoot 'build-release.ps1') -Version $Version
    if ($LASTEXITCODE -ne 0) { throw "Release build failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

$artifactsRoot = Join-Path $sourceRoot 'artifacts'
$releaseRoot = Join-Path $artifactsRoot 'release\KA-Asset-Batch'
$prerequisiteRoot = Join-Path $artifactsRoot 'prerequisites'
$installerRoot = Join-Path $artifactsRoot 'installer'
New-Item -ItemType Directory -Path $prerequisiteRoot,$installerRoot -Force | Out-Null

$webViewBootstrapper = Join-Path $prerequisiteRoot 'MicrosoftEdgeWebview2Setup.exe'
if (-not (Test-Path -LiteralPath $webViewBootstrapper)) {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $webViewBootstrapper
}
$signature = Get-AuthenticodeSignature -LiteralPath $webViewBootstrapper
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') {
    throw "Microsoft WebView2 bootstrapper signature validation failed: $($signature.Status)"
}

$isccCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
)
$iscc = $isccCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 (ISCC.exe) was not found. Install JRSoftware.InnoSetup first.' }

& $iscc "/DMyAppVersion=$Version" "/DReleaseDir=$releaseRoot" "/DPrerequisiteDir=$prerequisiteRoot" "/DOutputDir=$installerRoot" (Join-Path $PSScriptRoot 'installer.iss')
if ($LASTEXITCODE -ne 0) { throw "Installer compile failed with exit code $LASTEXITCODE" }

$installer = Get-ChildItem -LiteralPath $installerRoot -Filter "KA-Asset-Batch-Setup-$Version.exe" | Select-Object -First 1
if (-not $installer) { throw 'Installer compile finished but the expected output file was not found.' }
$hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$hashLine = "$hash  $($installer.Name)"
$hashLine | Set-Content -LiteralPath (Join-Path $installerRoot 'SHA256SUMS.txt') -Encoding ASCII

Write-Host "INSTALLER_READY=$($installer.FullName)"
Write-Host "INSTALLER_SHA256=$hash"
