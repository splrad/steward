import {afterEach,expect,it,vi} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse} from 'yaml';
import {registerOfflineFixtureRoot,permitOfflineScript} from './offline-fixtures.js';
import {isolatedBuildEnvironment} from '../src/build-environment.js';
vi.setConfig({testTimeout:60_000});
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function run(script:string) {
  const root=await mkdtemp(join(tmpdir(),'ghcr-offline-'));roots.push(root);registerOfflineFixtureRoot(root);
  const apiConfig=await readFile('config/github-api.json');
  for(const directory of ['config','controller/config','scripts'])await mkdir(join(root,directory),{recursive:true});
  for(const path of ['config/github-api.json','controller/config/github-api.json'])await writeFile(join(root,path),apiConfig);
  const path=join(root,'scripts','fixture.ps1');await writeFile(path,script);permitOfflineScript(path);
  return (await promisify(execFile)('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-File',path],{cwd:root,env:isolatedBuildEnvironment(process.env,root),windowsHide:true,timeout:55_000})).stdout;
}
const owner=`$owner=@{schemaVersion=1;ownerId=302208797;repositoryId=1187527897;packageType='container';target='layerscape-assets';packageIds=@();targetId=$null;observedAt='2026-10-01T00:00:00Z'}`;
it.each(['missing','wrong-owner','wrong-repository','wrong-target'])('rejects metadata identity boundary %s',async scenario=>{
  const helper=await readFile('scripts/ghcr-package-state.ps1','utf8');
  const output=await run(helper+`\n${owner}
$global:requests=0;$scenario='${scenario}'
function Invoke-WebRequest {
  param($Uri,$Headers,[switch]$SkipHttpErrorCheck)
  $global:requests++
  if($Headers.Authorization -cne 'Bearer offline-metadata'){throw 'wrong metadata credential'}
  $package=@{id=4;name='layerscape-assets';owner=@{id=302208797};repository=@{id=1187527897};package_type='container';visibility='private'}
  if($scenario -eq 'wrong-owner'){$package.owner.id=1}
  if($scenario -eq 'wrong-repository'){$package.repository.id=1}
  if($scenario -eq 'wrong-target'){$package.name='other-package'}
  if($Uri -like '*?package_type=*'){return @{StatusCode=200;Content=ConvertTo-Json -InputObject @($package) -Depth 8 -Compress;Headers=@{}}}
  return @{StatusCode=200;Content=$package|ConvertTo-Json -Depth 8 -Compress;Headers=@{}}
}
$denied=$false
try {$null=Get-LayerScapePackageState -Token $(if($scenario -eq 'missing'){''}else{'offline-metadata'}) -OwnerInventory ($owner|ConvertTo-Json -Compress)}
catch {if($_.Exception.Message -notlike 'GHCR_*'){throw};$denied=$true}
if(-not $denied -or ($scenario -eq 'missing' -and $global:requests)){throw 'unsafe metadata boundary'}
Write-Output 'PASS metadata boundary'
`);
  expect(output).toContain('PASS metadata boundary');
});
it('injects metadata and registry credentials only into their fixed consumers',async()=>{
  const workflow=parse(await readFile('templates/release/steward-release-channels.yml','utf8'));
  let metadataSteps=0;
  for(const job of Object.values(workflow.jobs) as any[]){
    for(const step of job.steps??[]){
      if(step.env?.GHCR_METADATA_TOKEN){
        metadataSteps++;
        expect(step.env.GHCR_METADATA_TOKEN).toBe('${{ secrets.CHANNEL_READ_TOKEN }}');
        expect(step.env.GHCR_TOKEN).toBe('${{ github.token }}');
        expect(['channel-read','package-publish']).toContain(job.environment.name);
        expect(step.run).not.toMatch(/\$env:GHCR_METADATA_TOKEN\s*\|\s*oras/);
        expect(step.run).not.toContain('Get-LayerScapePackageState -Token $env:GHCR_TOKEN');
        expect(step.run).toContain('Remove-Item Env:GHCR_METADATA_TOKEN');
      }
      if(step.name==='business-ghcr-verify'){
        expect(step.env).toEqual({MODE:'verify'});
        expect(step.run).toContain("'{\"auths\":{}}'");
      }
      expect(step.env?.CHANNEL_READ_TOKEN).toBeUndefined();
    }
  }
  expect(metadataSteps).toBe(3);
});
it('proves first package absence with one dedicated metadata credential and complete pages; denies visibility gaps',async()=>{
  const helper=await readFile('scripts/ghcr-package-state.ps1','utf8');
  const output=await run(helper+`\n${owner}
$ErrorActionPreference='Stop'
function Invoke-WebRequest {
  param($Uri,$Headers,[switch]$SkipHttpErrorCheck)
  if ($Headers.Authorization -cne 'Bearer offline-token') { throw 'wrong credential' }
  if ($Uri -like '*?package_type=*') {
    if ($global:scenario -eq 'denied') { return @{StatusCode=403;Content='{}';Headers=@{}} }
    if ($global:scenario -eq 'bad-request') { return @{StatusCode=400;Content='{}';Headers=@{}} }
    $page=[int]([regex]::Match($Uri,'&page=(\\d+)').Groups[1].Value)
    if ($global:scenario -in @('multipage','truncated','duplicate')) {
      $items=@(1..100 | ForEach-Object { @{id=$_;owner=@{id=302208797};package_type='container';name="fixture-$_"} })
      if ($page -eq 2 -and $global:scenario -ne 'duplicate') { $items=@() }
      $link=if($page -eq 1 -and $global:scenario -ne 'truncated') {'<https://api.github.com/orgs/splrad/packages?package_type=container&per_page=100&page=2>; rel="next"'} else {''}
      return @{StatusCode=200;Content=ConvertTo-Json -InputObject $items -Depth 5 -Compress;Headers=@{Link=$link}}
    }
    return @{StatusCode=200;Content='[]';Headers=@{}}
  }
  if ($Uri -cne 'https://api.github.com/orgs/splrad/packages/container/layerscape-assets') { throw 'unexpected endpoint' }
  return @{StatusCode= $(if($global:scenario -eq 'target-denied'){403}else{404});Content='{}';Headers=@{}}
}
foreach($scenario in @('absent','multipage','truncated','duplicate','denied','bad-request','target-denied','scope-gap')) {
  $global:scenario=$scenario;$owner.packageIds=@();if($scenario -eq 'scope-gap'){$owner.packageIds=@(777)}
  $success=$false
  try { $result=Get-LayerScapePackageState -Token offline-token -OwnerInventory ($owner|ConvertTo-Json -Compress);$success=$result.state -eq 'ABSENT' } catch { if($_.Exception.Message -notlike 'GHCR_*') { throw } }
  if($success -ne ($scenario -in @('absent','multipage'))) { throw "wrong absence result $scenario" }
  Write-Output "PASS $scenario"
}`);
  expect(output.match(/PASS /g)).toHaveLength(8);
});
it.each(['created','lost-response','same-digest','different-digest','metadata-denied'])('executes fixed GHCR submit as %s with separated credentials and no unsupported writes',async scenario=>{
  const workflow=parse(await readFile('templates/release/steward-release-channels.yml','utf8'));
  const business=Object.values(workflow.jobs).flatMap((job:any)=>job.steps).find((step:any)=>step.name==='business-ghcr-submit').run;
  const helper=await readFile('scripts/ghcr-package-state.ps1','utf8');
  const encoded=Buffer.from(helper).toString('base64'),script=Buffer.from(business).toString('base64');
  const output=await run(`$ErrorActionPreference='Stop'
${owner}
$scenario='${scenario}';$global:uploaded=$false;$global:copies=0;$global:tags=0;$global:anonymous=0
$env:RUNNER_TEMP=$pwd.Path;$env:GHCR_TOKEN='offline-registry';$env:GHCR_METADATA_TOKEN='offline-metadata';$env:GITHUB_ACTOR='fixture';$env:MODE='submit';$env:GHCR_OWNER_PACKAGE_INVENTORY=$owner|ConvertTo-Json -Compress
New-Item -ItemType Directory -Path final,controller/scripts|Out-Null
[IO.File]::WriteAllBytes('controller/scripts/ghcr-package-state.ps1',[Convert]::FromBase64String('${encoded}'))
[IO.File]::WriteAllBytes('business.ps1',[Convert]::FromBase64String('${script}'))
@{version='1.0.0';artifacts=@(@{path='AFR-Deployer_v1.0.0.exe'},@{path='AFR-DLL_v1.0.0.zip'},@{path='Fonts.zip'})}|ConvertTo-Json -Depth 8|Set-Content manifest.json
foreach($name in @('AFR-Deployer_v1.0.0.exe','AFR-DLL_v1.0.0.zip','Fonts.zip','sbom.spdx.json','release-notes.md','artifact-manifest.json','SHA256SUMS')){Set-Content -LiteralPath "final/$name" -Value 'fixture'}
function Invoke-WebRequest {
  param($Uri,$Headers,[switch]$SkipHttpErrorCheck)
  if($Headers.Authorization -cne 'Bearer offline-metadata'){throw 'wrong metadata credential'}
  if($scenario -eq 'metadata-denied'){return @{StatusCode=400;Content='{}';Headers=@{}}}
  $exists=$scenario -in @('same-digest','different-digest') -or $global:uploaded
  $package=@{id=4;name='layerscape-assets';owner=@{id=302208797};repository=@{id=1187527897};package_type='container';visibility='private'}
  if($Uri -like '*?package_type=*'){return @{StatusCode=200;Content=ConvertTo-Json -InputObject @($(if($exists){$package})) -Depth 8 -Compress;Headers=@{}}}
  return @{StatusCode=$(if($exists){200}else{404});Content=$package|ConvertTo-Json -Depth 8 -Compress;Headers=@{}}
}
function oras {
  $global:LASTEXITCODE=0
  if(Test-Path Env:GHCR_METADATA_TOKEN){throw 'metadata credential inherited by ORAS'}
  if($args -contains 'oras-anonymous.json'){$global:anonymous++;throw 'anonymous visibility required during submit'}
  switch($args[0]) {
    'login' {if((@($input) -join '') -cne 'offline-registry'){throw 'wrong registry credential'};return}
    'push' {if(@($args|Where-Object{$_ -in @('AFR-Deployer_v1.0.0.exe','AFR-DLL_v1.0.0.zip','Fonts.zip','sbom.spdx.json','release-notes.md','artifact-manifest.json','SHA256SUMS')}).Count -ne 7){throw 'seven file layout'};return}
    'resolve' {if($args -contains '--oci-layout' -or $global:uploaded -or $scenario -eq 'same-digest'){return 'sha256:'+('a'*64)};if($scenario -eq 'different-digest'){return 'sha256:'+('b'*64)};$global:LASTEXITCODE=1;return}
    'repo' {$global:tags++;throw 'nonexistent package tags must not be required'}
    'cp' {$global:copies++;$global:uploaded=$true;if($scenario -eq 'lost-response'){$global:LASTEXITCODE=1};return}
    default {throw ('unexpected ORAS '+$args[0])}
  }
}
$conflict=$false;$metadataDenied=$false
try { & ./business.ps1 }catch{if($_.Exception.Message -eq 'ASSET_CONFLICT'){$conflict=$true}elseif($_.Exception.Message -eq 'GHCR_METADATA_VISIBILITY_UNKNOWN'){$metadataDenied=$true}else{throw}}
if($scenario -eq 'metadata-denied'){if(-not $metadataDenied -or $global:copies -or (Test-Path native.json)){throw 'metadata failure did not block publication'}}
elseif($scenario -eq 'different-digest'){if(-not $conflict -or $global:copies){throw 'conflict overwritten'}}
else {
  $native=Get-Content native.json -Raw|ConvertFrom-Json
  if(-not $native.accepted -or $native.indexed -or $native.consumed -or $native.id -ne ('sha256:'+('a'*64))){throw 'acceptance/pending contract'}
  if($global:copies -ne $(if($scenario -eq 'same-digest'){0}else{1})){throw 'duplicate upload'}
}
if($global:tags -or $global:anonymous){throw 'first package dependency'}
Write-Output 'PASS submit'
`);
  expect(output).toContain('PASS submit');
});
it('keeps private and not-yet-anonymous packages pending in the actual readiness script',async()=>{
  const workflow=parse(await readFile('templates/release/steward-release-channels.yml','utf8'));
  const script=Object.values(workflow.jobs).flatMap((job:any)=>job.steps).find((step:any)=>step.name==='Read current channel readiness').run;
  const helper=Buffer.from(await readFile('scripts/ghcr-package-state.ps1','utf8')).toString('base64');
  const output=await run(`$ErrorActionPreference='Stop'
${owner}
$env:RUNNER_TEMP=$pwd.Path;$env:GHCR_TOKEN='offline-registry';$env:GHCR_METADATA_TOKEN='offline-read';$env:GITHUB_ACTOR='fixture';$env:GHCR_OWNER_PACKAGE_INVENTORY=$owner|ConvertTo-Json -Compress
New-Item -ItemType Directory -Path controller/scripts|Out-Null
[IO.File]::WriteAllBytes('controller/scripts/ghcr-package-state.ps1',[Convert]::FromBase64String('${helper}'))
[IO.File]::WriteAllBytes('readiness.ps1',[Convert]::FromBase64String('${Buffer.from(script).toString('base64')}'))
@{targets=@(@{unitId='layerscape';channelId='ghcr-assets';version='1.0.0'})}|ConvertTo-Json -Depth 5|Set-Content selection.json
function Invoke-WebRequest {
  param($Uri,$Headers,[switch]$SkipHttpErrorCheck)
  if($Headers.Authorization -cne 'Bearer offline-read'){throw 'credential mismatch'}
  $package=@{id=4;name='layerscape-assets';owner=@{id=302208797};repository=@{id=1187527897};package_type='container';visibility=$(if($global:scenario -eq 'private'){'private'}else{'public'})}
  if($Uri -like '*?package_type=*'){return @{StatusCode=200;Content=ConvertTo-Json -InputObject @($package) -Depth 8 -Compress;Headers=@{}}}
  return @{StatusCode=200;Content=$package|ConvertTo-Json -Depth 8 -Compress;Headers=@{}}
}
function oras {
  $global:LASTEXITCODE=0
  if(Test-Path Env:GHCR_METADATA_TOKEN){throw 'metadata credential inherited by ORAS'}
  switch($args[0]) {
    'login' {if((@($input) -join '') -cne 'offline-registry'){throw 'wrong registry credential'};return}
    'repo' {return '{"tags":["1.0.0"]}'}
    'resolve' {
      if(@($args|Where-Object {$_ -like '*oras-probe-anonymous.json'}).Count){$global:anonymous++;if($global:scenario -eq 'public-pending'){$global:LASTEXITCODE=1;return}}
      return 'sha256:'+('a'*64)
    }
    default {throw 'unexpected business execution'}
  }
}
foreach($scenario in @('private','public-pending','public-ready')){
  $env:GHCR_METADATA_TOKEN='offline-read'
  $global:scenario=$scenario;$global:anonymous=0;& ./readiness.ps1
  $item=@(Get-Content reads.json -Raw|ConvertFrom-Json)[0]
  if(-not $item.exists -or -not $item.accepted -or $item.indexed -ne ($scenario -eq 'public-ready') -or $item.readStatus -cne $(if($scenario -eq 'public-ready'){'OK'}else{'PENDING'})){throw 'pending/indexed contract'}
  if($global:anonymous -ne $(if($scenario -eq 'private'){0}else{1})){throw 'visibility probe contract'}
  Write-Output "PASS $scenario"
}`);
  expect(output.match(/PASS /g)).toHaveLength(3);
});
it.each(['Read current channel readiness','Read native registry PR and index'])('does not require GHCR metadata for winget-only selection in %s',async stepName=>{
  const workflow=parse(await readFile('templates/release/steward-release-channels.yml','utf8'));
  const script=Object.values(workflow.jobs).flatMap((job:any)=>job.steps).find((step:any)=>step.name===stepName).run;
  const output=await run(`$ErrorActionPreference='Stop'
$env:RUNNER_TEMP=$pwd.Path;$env:GHCR_TOKEN='offline-registry';$env:GITHUB_ACTOR='fixture';$env:WINGET_FORK_REPOSITORY='axiomoth/winget-pkgs'
Remove-Item Env:GHCR_METADATA_TOKEN -ErrorAction SilentlyContinue
@{targets=@(@{unitId='layerscape';channelId='winget';version='1.0.0'})}|ConvertTo-Json -Depth 5|Set-Content selection.json
[IO.File]::WriteAllBytes('read.ps1',[Convert]::FromBase64String('${Buffer.from(script).toString('base64')}'))
function Invoke-WebRequest {throw 'winget selection requested GHCR metadata'}
function Invoke-RestMethod {throw 'winget selection requested GHCR identity'}
function oras {
  if(Test-Path Env:GHCR_METADATA_TOKEN){throw 'metadata inherited by ORAS'}
  if($args[0] -ne 'login' -or (@($input) -join '') -cne 'offline-registry'){throw 'unexpected registry call'}
  $global:LASTEXITCODE=0
}
function gh {
  $global:LASTEXITCODE=0;$uri=$args[-1]
  if($uri -ceq 'repos/axiomoth/winget-pkgs'){return '{"id":11,"full_name":"axiomoth/winget-pkgs","private":false,"fork":true,"owner":{"type":"User","login":"axiomoth"},"parent":{"full_name":"microsoft/winget-pkgs"}}'}
  if($uri -ceq 'repos/microsoft/winget-pkgs'){return '{"id":12,"default_branch":"master"}'}
  if($uri -like 'repos/microsoft/winget-pkgs/pulls?*'){return '[[]]'}
  throw 'unexpected gh call'
}
function winget {throw 'unexpected index call without PR'}
& ./read.ps1
$items=@(Get-Content reads.json -Raw|ConvertFrom-Json)
if($items.Count -ne 1 -or $items[0].channelId -cne 'winget' -or $items[0].readStatus -cne 'NOT_FOUND_CONFIRMED'){throw 'winget-only selection blocked'}
Write-Output 'PASS winget-only'
`);
  expect(output).toContain('PASS winget-only');
});
