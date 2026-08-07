$ErrorActionPreference = 'Stop'
$runtimeArguments = @($args)
$utf8 = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8
try { [Console]::InputEncoding = $utf8 } catch {}
try { [Console]::OutputEncoding = $utf8 } catch {}
chcp.com 65001 | Out-Null

$runtimeExe = $null
$bundledModules = $null
if ($env:USERPROFILE) {
  $bundledRoot = [IO.Path]::Combine($env:USERPROFILE, '.cache\codex-runtimes\codex-primary-runtime\dependencies\node')
  $bundledExe = [IO.Path]::Combine($bundledRoot, 'bin\node.exe')
  if (Test-Path -LiteralPath $bundledExe -PathType Leaf) {
    $runtimeExe = $bundledExe
    $bundledModules = [IO.Path]::Combine($bundledRoot, 'node_modules')
  }
}

if (-not $runtimeExe) {
  $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { $runtimeExe = $command.Source }
}

if (-not $runtimeExe) {
  [Console]::Error.WriteLine('[ERROR] Node.js was not found. Install Node.js 18+ or run this Skill inside Codex Desktop.')
  exit 9009
}

$previousModules = [Environment]::GetEnvironmentVariable('CODEX_NODE_MODULES', 'Process')
$runtimeExitCode = 1
try {
  if ($bundledModules) {
    [Environment]::SetEnvironmentVariable('CODEX_NODE_MODULES', $bundledModules, 'Process')
  }
  & $runtimeExe @runtimeArguments
  $runtimeExitCode = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine("[ERROR] Node.js failed to start: $($_.Exception.Message)")
  $runtimeExitCode = 1
} finally {
  [Environment]::SetEnvironmentVariable('CODEX_NODE_MODULES', $previousModules, 'Process')
}

exit $runtimeExitCode
