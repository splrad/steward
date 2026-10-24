[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Archive,
  [Parameter(Mandatory)][string]$ExpectedSha256,
  [Parameter(Mandatory)][string]$ExpectedNames,
  [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid archive digest' }
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256) { throw 'Artifact archive digest mismatch' }
$names = @(Get-Content -LiteralPath $ExpectedNames -Raw | ConvertFrom-Json)
if ($names.Count -eq 0 -or @($names | Sort-Object -Unique).Count -ne $names.Count) { throw 'Invalid expected file set' }
foreach ($name in $names) {
  if ($name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$' -or $name.EndsWith('.') -or $name -imatch '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)') { throw 'Unsafe file name' }
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output already exists' }
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  if ($zip.Entries.Count -ne $names.Count) { throw 'Archive file set mismatch' }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [long]$total = 0
  foreach ($entry in $zip.Entries) {
    if (-not $seen.Add($entry.FullName) -or -not ($names -ccontains $entry.FullName)) { throw 'Unexpected or duplicate archive entry' }
    $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
    if ($unixType -ne 0 -and $unixType -ne 0x8000) { throw 'Archive contains non-regular entry' }
    if ($entry.Length -le 0 -or $entry.Length -ge 2147483648) { throw 'Invalid archive entry size' }
    $total += $entry.Length
    if ($total -ge 2147483648) { throw 'Archive size limit' }
  }
  [void][IO.Directory]::CreateDirectory($OutputDirectory)
  foreach ($entry in $zip.Entries) {
    $inputStream = $entry.Open()
    $outputStream = [IO.File]::Open((Join-Path $OutputDirectory $entry.FullName), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $inputStream.CopyTo($outputStream); if ($outputStream.Length -ne $entry.Length) { throw 'Extracted size mismatch' } }
    finally { $outputStream.Dispose(); $inputStream.Dispose() }
  }
} finally { $zip.Dispose() }
