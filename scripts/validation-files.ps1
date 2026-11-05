param([Parameter(Mandatory)][string]$Workspace)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Workspace).Path
$files = (& git -C $root ls-files) | Where-Object { $_ -match '\.(ps1|props|targets|csproj|slnx)$' }
if ($LASTEXITCODE) { throw 'VALIDATION_FILE_LIST' }
foreach ($name in $files) {
    $path = [IO.Path]::GetFullPath((Join-Path $root $name))
    if (!$path.StartsWith($root + [IO.Path]::DirectorySeparatorChar) -or (Get-Item -LiteralPath $path).LinkType) { throw 'VALIDATION_FILE_BOUNDARY' }
    if ($name.EndsWith('.ps1')) {
        $tokens = $null; $errors = $null
        [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) > $null
        if ($errors.Count) { throw ($errors.Message -join "`n") }
    } else { [xml](Get-Content -LiteralPath $path -Raw) > $null }
}
Write-Output "Parsed $(@($files).Count) PowerShell/MSBuild files"
