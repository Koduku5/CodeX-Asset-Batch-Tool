$ErrorActionPreference = 'Stop'
$runtimeArguments = @($args)
$utf8 = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8
try { [Console]::InputEncoding = $utf8 } catch {}
try { [Console]::OutputEncoding = $utf8 } catch {}
chcp.com 65001 | Out-Null

$runtimeExe = $null
$runtimePrefix = @()
if ($env:USERPROFILE) {
  $bundledExe = [IO.Path]::Combine($env:USERPROFILE, '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
  if (Test-Path -LiteralPath $bundledExe -PathType Leaf) {
    $runtimeExe = $bundledExe
  }
}

if (-not $runtimeExe) {
  $command = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and $command.Source -notmatch '\\Microsoft\\WindowsApps\\python\.exe$') {
    $runtimeExe = $command.Source
  }
}
if (-not $runtimeExe) {
  $command = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) {
    $runtimeExe = $command.Source
    $runtimePrefix = @('-3')
  }
}
if (-not $runtimeExe) {
  [Console]::Error.WriteLine('[ERROR] Python was not found. Install Python 3.10+ or run this Skill inside Codex Desktop.')
  exit 9009
}

$environmentNames = @('PYTHONUTF8', 'PYTHONIOENCODING', 'PYTHONDONTWRITEBYTECODE')
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$runtimeExitCode = 1
try {
  [Environment]::SetEnvironmentVariable('PYTHONUTF8', '1', 'Process')
  [Environment]::SetEnvironmentVariable('PYTHONIOENCODING', 'utf-8', 'Process')
  [Environment]::SetEnvironmentVariable('PYTHONDONTWRITEBYTECODE', '1', 'Process')
  $allArguments = @($runtimePrefix) + @($runtimeArguments)
  & $runtimeExe @allArguments
  $runtimeExitCode = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine("[ERROR] Python failed to start: $($_.Exception.Message)")
  $runtimeExitCode = 1
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
}

exit $runtimeExitCode
