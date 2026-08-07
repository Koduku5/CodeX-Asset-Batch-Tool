[CmdletBinding()]
param(
    [string]$Version,
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactsRoot = [System.IO.Path]::GetFullPath((Join-Path $sourceRoot 'artifacts'))
$package = Get-Content (Join-Path $sourceRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = [string]$package.version }
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $artifactsRoot 'release\KA-Asset-Batch'
}
$releaseRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$requiredPrefix = $artifactsRoot.TrimEnd('\') + '\'
if (-not $releaseRoot.StartsWith($requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release directory must stay under $artifactsRoot; received $releaseRoot"
}

if (Test-Path -LiteralPath $releaseRoot) {
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

$desktopProject = Join-Path $sourceRoot 'desktop\PromptStudio.Desktop\PromptStudio.Desktop.csproj'
& dotnet publish $desktopProject -c Release -r win-x64 --self-contained true -p:PublishDir="$releaseRoot\"
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

$sidecarRoot = Join-Path $releaseRoot 'sidecar'
$sidecarManifestRoot = Join-Path $sourceRoot 'packaging\sidecar'
Copy-Item -LiteralPath (Join-Path $sidecarManifestRoot 'package.json') -Destination (Join-Path $sidecarRoot 'package.json') -Force
Copy-Item -LiteralPath (Join-Path $sidecarManifestRoot 'package-lock.json') -Destination (Join-Path $sidecarRoot 'package-lock.json') -Force
$sidecarModules = Join-Path $sidecarRoot 'node_modules'
if (Test-Path -LiteralPath $sidecarModules) {
    Remove-Item -LiteralPath $sidecarModules -Recurse -Force
}
& npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix $sidecarRoot
if ($LASTEXITCODE -ne 0) { throw "sidecar production dependency install failed with exit code $LASTEXITCODE" }

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeRoot = Join-Path $releaseRoot 'runtime\node'
New-Item -ItemType Directory -Path $nodeRoot -Force | Out-Null
Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $nodeRoot 'node.exe') -Force

Get-ChildItem -LiteralPath $releaseRoot -Recurse -File |
    Where-Object { $_.Extension -in @('.pdb', '.xml') } |
    Remove-Item -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'README.md') -Destination (Join-Path $releaseRoot 'README.md') -Force

$forbidden = @('workspace', '.local', 'tests')
foreach ($name in $forbidden) {
    if (Test-Path -LiteralPath (Join-Path $releaseRoot $name)) {
        throw "Release directory must not contain $name"
    }
}

$files = Get-ChildItem -LiteralPath $releaseRoot -Recurse -File | Sort-Object FullName
$requiredFiles = @(
    'KA.PromptStudio.exe',
    'runtime\node\node.exe',
    'sidecar\src\server\desktop-entry.mjs',
    'sidecar\dist\renderer\index.html',
    'sidecar\node_modules\@openai\codex-sdk\package.json'
)
foreach ($relativePath in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $releaseRoot $relativePath) -PathType Leaf)) {
        throw "Release directory is missing required file: $relativePath"
    }
}
if ($files.Count -lt 100) {
    throw "Release file count is unexpectedly low: $($files.Count)"
}
$manifestFiles = foreach ($file in $files) {
    [ordered]@{
        path = $file.FullName.Substring($releaseRoot.Length).TrimStart('\') -replace '\\', '/'
        bytes = $file.Length
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$manifest = [ordered]@{
    product = 'KA Asset Batch'
    version = $Version
    target = 'win-x64'
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    fileCount = $manifestFiles.Count
    files = $manifestFiles
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $releaseRoot 'release-manifest.json') -Encoding UTF8

Write-Host "RELEASE_READY=$releaseRoot"
Write-Host "RELEASE_FILES=$($manifestFiles.Count)"
Write-Host "RELEASE_BYTES=$((Get-ChildItem -LiteralPath $releaseRoot -Recurse -File | Measure-Object Length -Sum).Sum)"
