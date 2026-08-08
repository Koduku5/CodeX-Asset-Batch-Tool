[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$scriptsRoot = Split-Path -Parent $PSScriptRoot
$failed = $false

Get-ChildItem -LiteralPath $scriptsRoot -Recurse -Filter '*.ps1' -File |
  Sort-Object FullName |
  ForEach-Object {
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile(
      $_.FullName,
      [ref]$tokens,
      [ref]$errors
    ) | Out-Null
    foreach ($parseError in @($errors)) {
      $failed = $true
      [Console]::Error.WriteLine(
        '{0}:{1}:{2}: {3}',
        $_.FullName,
        $parseError.Extent.StartLineNumber,
        $parseError.Extent.StartColumnNumber,
        $parseError.Message
      )
    }
  }

if ($failed) { exit 1 }
