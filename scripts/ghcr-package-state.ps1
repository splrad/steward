# Metadata-only caller input; ORAS retains the separate repository GITHUB_TOKEN.
function Get-LayerScapePackageState {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Token, [Parameter(Mandatory)][string]$OwnerInventory)
    $ErrorActionPreference='Stop'
    if ([string]::IsNullOrWhiteSpace($Token)) { throw 'GHCR_METADATA_TOKEN_REQUIRED' }
    $owner=$OwnerInventory | ConvertFrom-Json -DateKind String
    if ($owner.schemaVersion -ne 1 -or $owner.ownerId -ne 302208797 -or $owner.repositoryId -ne 1187527897 -or
        $owner.packageType -cne 'container' -or $owner.target -cne 'layerscape-assets' -or
        $null -eq $owner.packageIds -or $owner.observedAt -notmatch '^\d{4}-\d{2}-\d{2}T' -or
        [DateTimeOffset]::Parse($owner.observedAt) -gt [DateTimeOffset]::UtcNow) { throw 'GHCR_OWNER_INVENTORY_REQUIRED' }
    $ids=@($owner.packageIds)
    if (@($ids | Sort-Object -Unique).Count -ne $ids.Count -or @($ids | Where-Object { $_ -isnot [long] -and $_ -isnot [int] -or $_ -le 0 }).Count) { throw 'GHCR_OWNER_INVENTORY_INVALID' }
    $apiVersion=(Get-Content -LiteralPath (Join-Path $PSScriptRoot '../config/github-api.json') -Raw | ConvertFrom-Json).version
    $headers=@{Authorization="Bearer $Token";Accept='application/vnd.github+json';'X-GitHub-Api-Version'=$apiVersion}
    $packages=@();$seen=@{};$complete=$false
    for ($page=1; $page -le 10000; $page++) {
        $response=Invoke-WebRequest -Uri "https://api.github.com/orgs/splrad/packages?package_type=container&per_page=100&page=$page" -Headers $headers -SkipHttpErrorCheck
        if ($response.StatusCode -ne 200) { throw 'GHCR_METADATA_VISIBILITY_UNKNOWN' }
        $body=$response.Content | ConvertFrom-Json -NoEnumerate
        if ($body -isnot [Array]) { throw 'GHCR_METADATA_PAGINATION_UNKNOWN' }
        foreach ($package in $body) {
            if ($package.id -le 0 -or $seen.ContainsKey([string]$package.id) -or $package.owner.id -ne 302208797 -or $package.package_type -cne 'container') { throw 'GHCR_METADATA_PAGINATION_UNKNOWN' }
            $seen[[string]$package.id]=$true;$packages+=,$package
        }
        $link=[string]$response.Headers.Link
        if ($link -notmatch 'rel="next"') { if ($body.Count -ge 100) { throw 'GHCR_METADATA_PAGINATION_UNKNOWN' };$complete=$true;break }
        if ($link -notmatch ('https://api.github.com/orgs/splrad/packages\?[^>]*page='+($page+1)+'(?:&|>)')) { throw 'GHCR_METADATA_PAGINATION_UNKNOWN' }
    }
    if (-not $complete -or @($ids | Where-Object { -not $seen.ContainsKey([string]$_) }).Count) { throw 'GHCR_METADATA_SCOPE_INCOMPLETE' }
    $target=@($packages | Where-Object { $_.name -ceq 'layerscape-assets' })
    if ($target.Count -gt 1) { throw 'GHCR_METADATA_TARGET_CONFLICT' }
    $exact=Invoke-WebRequest -Uri 'https://api.github.com/orgs/splrad/packages/container/layerscape-assets' -Headers $headers -SkipHttpErrorCheck
    if ($exact.StatusCode -eq 404 -and $target.Count -eq 0 -and $null -eq $owner.targetId) { return @{state='ABSENT';visibility=$null;id=$null} }
    if ($exact.StatusCode -ne 200 -or $target.Count -ne 1) { throw 'GHCR_METADATA_TARGET_UNKNOWN' }
    $package=$exact.Content | ConvertFrom-Json
    if ($package.id -ne $target[0].id -or $package.owner.id -ne 302208797 -or $package.name -cne 'layerscape-assets' -or
        $package.package_type -cne 'container' -or $package.repository.id -ne 1187527897 -or $package.visibility -notin @('public','private','internal') -or
        ($null -ne $owner.targetId -and $owner.targetId -ne $package.id)) { throw 'GHCR_METADATA_TARGET_CONFLICT' }
    return @{state='EXISTS';visibility=$package.visibility;id=$package.id}
}
