// Reconstruct historical workflow shapes for the archive-reader and controller tests.
import {posix} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import YAML from 'yaml';
import {repositoryPath} from '../../configuration-build.mjs';

const key = /^[a-z][a-z0-9-]*$/;
const pinned = /^actions\/(setup-(node|python|dotnet|go|java))@[0-9a-f]{40}$/;
const checkout = /^actions\/checkout@[0-9a-f]{40}$/;
const active = "steps.unit.outputs.selected == 'true' && steps.recover.outputs.found != 'true'";

const literalLabel = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

function runner(value) {
  requireValue(typeof value === 'string' && literalLabel.test(value), 'Expected a literal fixture runner label');
  return value;
}

function parseWorkflow(bytes) {
  const doc = YAML.parseDocument(bytes, {uniqueKeys:true});
  requireValue(!doc.errors.length, 'Invalid workflow YAML');
  return doc.toJS({maxAliasCount:0});
}

const collectFilesCommand=[
        "$ErrorActionPreference = 'Stop'",
        "$stage = Join-Path $env:RUNNER_TEMP 'delivery-files'",
        'New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null',
        '$unit = @(($env:BUILD_RECORD | ConvertFrom-Json).units | Where-Object { $_.id -ceq $env:UNIT })',
        "if ($unit.Count -ne 1) { throw 'Unknown release unit' }",
        'foreach ($selected in ($env:SELECTED_PATHS | ConvertFrom-Json)) {',
        '  $asset = @($unit[0].assets | Where-Object { $_.id -ceq $selected.id })',
        "  if ($asset.Count -ne 1) { throw 'Unknown selected asset' }",
        '  $relative = Join-Path $selected.directory $asset[0].name',
        '  $file = Get-Item -LiteralPath $relative -ErrorAction Stop',
        "  if ($file.PSIsContainer -or $file.LinkType) { throw 'Expected a regular delivery file' }",
        '  $target = Join-Path $stage $file.Name',
        "  if (Test-Path -LiteralPath $target) { throw 'Duplicate delivery filename' }",
        '  Copy-Item -LiteralPath $file.FullName -Destination $target',
        '}'].join('\n');

// Each source is an exact relative path observed within its archive. Keep debug files out of formal uploads.
export function renderBuild(seed, targets, {signing,controllerSha}) {
  requireValue(signing === 'not-applicable', 'A reviewed signing job or an explicit not-applicable decision is required');
  const doc = parseWorkflow(seed), build = doc.jobs.build;
  if(controllerSha) {
    requireValue(/^[0-9a-f]{40}$/.test(controllerSha),'Invalid controller revision');
    for(const job of Object.values(doc.jobs)) {
      if(job.uses?.startsWith('splrad/steward/.github/workflows/product-release.yml@')) job.uses=job.uses.split('@')[0]+'@'+controllerSha;
      for(const step of job.steps??[]) if(step.with?.repository==='splrad/steward') step.with.ref=controllerSha;
    }
  }
  const rows = [], inserted = [], conditions = [], seenAssets = new Set();
  requireValue(targets.length, 'Select at least one build target');
  for (const {unit,target,recipe,files} of targets) {
    requireValue(key.test(unit) && key.test(target) && files?.length && !rows.some(r=>r.unit===unit && r.target===target),'Invalid or duplicate build target');
    const label = runner(recipe.runner);
    const condition = `matrix.unit == '${unit}' && matrix.target == '${target}'`;
    conditions.push(`(${condition}) && '${label}'`);
    const paths = [];
    for (const file of files) {
      requireValue(key.test(file.id) && !seenAssets.has(unit+'/'+file.id),'Duplicate or invalid asset');
      seenAssets.add(unit+'/'+file.id);
      paths.push({id:file.id,directory:posix.dirname(posix.join('product',recipe.output??'.',repositoryPath(file.path)))});
    }
    rows.push({unit,target,assets:files.map(file=>file.id)});
    const guard = active + ' && ' + condition;
    if(recipe.native) {
      inserted.push({name:'Collect verified product workflow archive',if:guard,'working-directory':'controller',
        env:{GH_TOKEN:'${{ github.token }}',SOURCE_SHA:'${{ github.sha }}',BUILD_RECORD:'${{ needs.admit.outputs.record }}',
          UNIT:unit,TARGET:target,PRODUCER:Buffer.from(JSON.stringify(recipe.native)).toString('base64url'),SELECTED_FILES:JSON.stringify(files.map(f=>({id:f.id,directory:posix.dirname(f.path)})))},
        run:'node scripts/configuration-native-artifact.mjs'});
      continue;
    }
    for (const step of recipe.steps) inserted.push({...step,if:guard});
    inserted.push({name:'Collect selected files',shell:'pwsh',if:guard,
      env:{SELECTED_PATHS:JSON.stringify(paths),BUILD_RECORD:'${{ needs.admit.outputs.record }}',UNIT:unit},run:collectFilesCommand});
  }
  build.strategy.matrix = {include:rows};
  build['runs-on'] = targets.every(t=>t.recipe.runner===targets[0].recipe.runner)?targets[0].recipe.runner
    : '${{ '+conditions.join(' || ')+' }}';
  const slot = build.steps.findIndex(s=>s.id==='build');
  requireValue(slot>=0,'Missing product build slot');
  build.steps.splice(slot,1,...inserted);
  build.steps.find(s=>s.id==='upload').with.path = '${{ runner.temp }}/delivery-files/*';
  doc.jobs.sign.steps.find(s=>s.id==='signing').run = "echo 'result=NOT_APPLICABLE' >> \"$GITHUB_OUTPUT\"";
  return YAML.stringify(doc,{lineWidth:0});
}

/** Change only identifiable product slots. Preserve signing, recovery, and untouched producer jobs verbatim. */
export function adaptBuild(source,seed,targets,controllerSha) {
  const doc=YAML.parseDocument(source), current=parseWorkflow(source);
  const build=current.jobs?.build, rows=build?.strategy?.matrix?.include;
  const path=['jobs','build','steps'], nodes=doc.getIn(path,true);
  const fail=()=>{throw Error('保留 .github/workflows/steward-release-publish.yml；请维护者在 jobs.build 明确所选目标的受审入口，现有签名及自定义作业保持有效。');};
  if(!Array.isArray(rows) || !YAML.isSeq(nodes))fail();
  const start=build.steps.findIndex(s=>s.id==='recover'),end=build.steps.findIndex(s=>s.id==='upload');
  if(start<0 || end<=start || build.steps[end].with?.path!=='${{ runner.temp }}/delivery-files/*')fail();
  const selected=(row)=>targets.some(t=>t.unit===row.unit && t.target===row.target);
  const condition=(row)=>"matrix.unit == '"+row.unit+"' && matrix.target == '"+row.target+"'";
  const fullGuard=(row)=>active+' && '+condition(row);
  const rendered=parseWorkflow(renderBuild(seed,targets,{signing:'not-applicable'})).jobs.build;
  const generated=rendered.steps.slice(rendered.steps.findIndex(s=>s.id==='recover')+1,rendered.steps.findIndex(s=>s.id==='upload'));
  const controller=build.steps.find(step=>step.with?.repository==='splrad/steward' && step.with.path==='controller');
  if(controllerSha && targets.some(t=>t.recipe.native) && controller?.with.ref!==controllerSha) {
    requireValue(/^[a-f0-9]{40}$/.test(controllerSha) && checkout.test(controller?.uses??''),'Missing trusted controller checkout');
    for(const collect of [...generated].filter(s=>s.name==='Collect verified product workflow archive')) {
      const path='configuration-controller';
      const checkoutStep={name:'Check out native archive reader',if:collect.if,uses:controller.uses,
        with:{repository:'splrad/steward',ref:controllerSha,path,'persist-credentials':false}};
      const install={name:'Install native archive reader dependencies',if:collect.if,'working-directory':path,
        run:'npm ci --ignore-scripts --no-audit --no-fund'};
      generated.splice(generated.indexOf(collect),0,checkoutStep,install);
      collect['working-directory']=path;
    }
  }
  const kept=[],inserted=new Set();
  const insert=row=>{
    const guard=fullGuard(row);
    if(inserted.has(guard)) return;
    kept.push(...generated.filter(s=>s.if===guard).map(s=>doc.createNode(s)));
    inserted.add(guard);
  };
  for(let i=start+1;i<end;i++) {
    const step=build.steps[i],row=rows.find(r=>step.if===fullGuard(r));
    if(!row)fail();
    if(!selected(row)){kept.push(nodes.items[i]);continue;}
    insert(row);
    if(step.uses && pinned.test(step.uses))continue;
    if(step.name==='Run reviewed packaging entry' && step.run==='node product/.github/actions/configuration/'+row.unit+'/'+row.target+'/run.mjs')continue;
    if(step.name==='Check out native archive reader' && checkout.test(step.uses??'') && step.with?.path==='configuration-controller' && step.with.repository==='splrad/steward')continue;
    if(step.name==='Install native archive reader dependencies' && step['working-directory']==='configuration-controller' && step.run==='npm ci --ignore-scripts --no-audit --no-fund')continue;
    if(step.name==='Collect verified product workflow archive' && step.run==='node scripts/configuration-native-artifact.mjs' && ['controller','configuration-controller'].includes(step['working-directory']))continue;
    if(step.name==='Collect selected files' && step.run===collectFilesCommand)continue;
    fail();
  }
  const proposed=rendered.strategy.matrix.include;
  const sameRow=(a,b)=>a.unit===b.unit && a.target===b.target;
  const additions=proposed.filter(row=>!rows.some(other=>sameRow(row,other)));
  for(const row of additions) insert(row);
  const nextRows=[...rows.map(row=>proposed.find(other=>sameRow(row,other))??row),...additions];
  const labels=nextRows.map(row=>{
    const changed=targets.find(t=>t.unit===row.unit && t.target===row.target);
    if(changed)return runner(changed.recipe.runner);
    if(typeof build['runs-on'] === 'string' && literalLabel.test(build['runs-on']))return build['runs-on'];
    const clause="("+condition(row)+") && '";
    const matches=String(build['runs-on']).split(clause);
    if(matches.length!==2)fail();
    return runner(matches[1].split("'")[0]);
  });
  const runsOn=labels.every(label=>label===labels[0])?labels[0]:
    '${{ '+nextRows.map((row,i)=>'('+condition(row)+") && '"+labels[i]+"'").join(' || ')+' }}';
  if(runsOn===build['runs-on'] && isDeepStrictEqual(nextRows,rows)
    && isDeepStrictEqual(kept.map(node=>node.toJSON()),build.steps.slice(start+1,end))) return source;
  nodes.items.splice(start+1,end-start-1,...kept);
  doc.setIn(['jobs','build','strategy','matrix','include'],nextRows);
  doc.setIn(['jobs','build','runs-on'],runsOn);
  return doc.toString({lineWidth:0});
}
