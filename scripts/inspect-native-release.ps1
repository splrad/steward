param([Parameter(Mandatory=$true)][string]$LiteralPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Read-PeVersion([string]$Path) {
    $v = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    if ($v.FileVersion -notmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:\.0)?$') { throw 'RN_NATIVE_FILE_VERSION' }
    $public = "$($Matches[1]).$($Matches[2]).$($Matches[3])"
    if ($v.ProductVersion -notmatch '^([0-9]+\.[0-9]+\.[0-9]+)(?:\+[^\s]+)?$' -or $Matches[1] -cne $public) { throw 'RN_NATIVE_PRODUCT_VERSION' }
    return $public
}
$extension = [IO.Path]::GetExtension($LiteralPath).ToLowerInvariant()
if ($extension -in '.exe', '.dll') { @{version=(Read-PeVersion $LiteralPath)} | ConvertTo-Json -Compress; exit 0 }
if ($extension -ne '.zip') { throw 'RN_NATIVE_FORMAT' }
Add-Type -AssemblyName System.IO.Compression
$archive = [IO.Compression.ZipFile]::OpenRead($LiteralPath)
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('steward-native-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
    if ($archive.Entries.Count -eq 0 -or $archive.Entries.Count -gt 4096) { throw 'RN_NATIVE_ARCHIVE_LIMIT' }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $versions = [Collections.Generic.HashSet[string]]::new()
    $fonts = 0; $dlls = 0; $expanded = 0L
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if ($name.StartsWith('/') -or $name -match '(^|/)\.\.(/|$)|:|[\x00-\x1f]' -or -not $names.Add($name)) { throw 'RN_NATIVE_ARCHIVE_PATH' }
        if ($name.EndsWith('/')) { if ($entry.Length -ne 0) { throw 'RN_NATIVE_ARCHIVE_PATH' }; continue }
        $expanded += $entry.Length
        if ($entry.Length -le 0 -or $entry.Length -gt 32MB -or $expanded -gt 256MB) { throw 'RN_NATIVE_ARCHIVE_LIMIT' }
        $ext = [IO.Path]::GetExtension($name).ToLowerInvariant()
        if ($ext -notin '.dll', '.shx', '.ttf', '.otf') { throw 'RN_NATIVE_ARCHIVE_FORMAT' }
        $stream = $entry.Open(); $memory = [IO.MemoryStream]::new()
        try {
            $buffer = [byte[]]::new(65536); $size = 0L
            while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $size += $count; if ($size -gt $entry.Length) { throw 'RN_NATIVE_ARCHIVE_SIZE' }
                $memory.Write($buffer, 0, $count)
            }
            if ($size -ne $entry.Length) { throw 'RN_NATIVE_ARCHIVE_SIZE' }
            $bytes = $memory.ToArray()
        } finally { $stream.Dispose(); $memory.Dispose() }
        if ($ext -eq '.dll') {
            $dlls++; $file = Join-Path $temporary 'version.dll'
            [IO.File]::WriteAllBytes($file, $bytes)
            $versions.Add((Read-PeVersion $file)) | Out-Null
            Remove-Item -LiteralPath $file
        } else {
            $fonts++
            $prefix = [Text.Encoding]::ASCII.GetString($bytes, 0, [Math]::Min(64, $bytes.Length))
            if (($ext -eq '.shx' -and $prefix -notmatch '^AutoCAD-86 (shapes|unifont|bigfont)') -or
                ($ext -eq '.otf' -and -not $prefix.StartsWith('OTTO')) -or
                ($ext -eq '.ttf' -and [BitConverter]::ToString($bytes, 0, [Math]::Min(4,$bytes.Length)) -notin '00-01-00-00','74-72-75-65','74-74-63-66')) { throw 'RN_NATIVE_FONT' }
        }
    }
    if ($dlls -gt 0 -and $fonts -eq 0 -and $versions.Count -eq 1) { @{version=@($versions)[0]} | ConvertTo-Json -Compress }
    elseif ($fonts -gt 0 -and $dlls -eq 0) { @{resourceOnly='font-archive'} | ConvertTo-Json -Compress }
    else { throw 'RN_NATIVE_ARCHIVE_VERSION' }
} finally {
    $archive.Dispose()
    # Only the uniquely created, fixed-parent inspection directory is removed.
    $resolved = [IO.Path]::GetFullPath($temporary)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^steward-native-[a-f0-9]{32}$') { throw 'RN_NATIVE_TEMP_PATH' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
