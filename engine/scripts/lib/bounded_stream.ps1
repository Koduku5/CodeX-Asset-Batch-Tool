function Read-LimitedStreamBytes {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.Stream]$Stream,
    [long]$DeclaredLength = -1,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, [long]::MaxValue)]
    [long]$MaxBytes,
    [string]$Label = 'response'
  )

  if ($DeclaredLength -gt $MaxBytes) {
    throw "$Label declares $DeclaredLength bytes; limit is $MaxBytes bytes."
  }

  $buffer = New-Object byte[] 65536
  $memory = [System.IO.MemoryStream]::new()
  try {
    $total = [long]0
    while ($true) {
      $remainingWithSentinel = $MaxBytes - $total + 1
      $requested = [int][Math]::Min([long]$buffer.Length, $remainingWithSentinel)
      $read = $Stream.Read($buffer, 0, $requested)
      if ($read -le 0) { break }
      if ($read -gt ($MaxBytes - $total)) {
        throw "$Label exceeds $MaxBytes bytes."
      }
      $memory.Write($buffer, 0, $read)
      $total += $read
    }
    return $memory.ToArray()
  } finally {
    $memory.Dispose()
  }
}
