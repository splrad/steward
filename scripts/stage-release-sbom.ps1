[CmdletBinding()]
param([Parameter(Mandatory)][string]$AssetsDirectory, [Parameter(Mandatory)][string]$StagingDirectory)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $StagingDirectory) { throw 'SBOM staging already exists' }
[void][IO.Directory]::CreateDirectory($StagingDirectory)
$root = [IO.Path]::GetFullPath($StagingDirectory).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
foreach ($file in Get-ChildItem -LiteralPath $AssetsDirectory -File) {
  if ($file.Extension -eq '.zip') {
    $zip = [IO.Compression.ZipFile]::OpenRead($file.FullName)
    try {
      if ($zip.Entries.Count -eq 0 -or $zip.Entries.Count -gt 4096) { throw 'SBOM archive entry limit' }
      $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      [long]$expanded = 0
      foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\','/')
        if ($name.StartsWith('/') -or $name -match '(^|/)\.\.?(/|$)|:|[\x00-\x1f]' -or -not $seen.Add($name)) { throw 'SBOM archive path' }
        foreach ($segment in $name.TrimEnd('/').Split('/')) {
          if ([string]::IsNullOrEmpty($segment) -or $segment -match '[. ]$|^(?i:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)') { throw 'SBOM archive Windows path' }
        }
        $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
        if ($unixType -ne 0 -and $unixType -ne 0x8000 -and $unixType -ne 0x4000) { throw 'SBOM archive link' }
        if ($name.EndsWith('/')) { if ($entry.Length -ne 0) { throw 'SBOM directory bytes' }; continue }
        $expanded += $entry.Length
        if ($entry.Length -le 0 -or $entry.Length -gt 32MB -or $expanded -gt 256MB) { throw 'SBOM archive size' }
        $destination = [IO.Path]::GetFullPath((Join-Path (Join-Path $StagingDirectory $file.Name) $name))
        if (-not $destination.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw 'SBOM path escapes staging' }
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
        $inputStream = $entry.Open(); $outputStream = [IO.File]::Open($destination,[IO.FileMode]::CreateNew)
        try { $inputStream.CopyTo($outputStream); if ($outputStream.Length -ne $entry.Length) { throw 'SBOM size mismatch' } }
        finally { $outputStream.Dispose(); $inputStream.Dispose() }
      }
    } finally { $zip.Dispose() }
  } elseif ($file.Extension -in '.exe','.dll') {
    [IO.File]::Copy($file.FullName,(Join-Path $StagingDirectory $file.Name),$false)
  } else { throw 'Unsupported SBOM asset' }
}
