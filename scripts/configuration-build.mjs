import {posix} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import YAML from 'yaml';

const key = /^[a-z][a-z0-9-]*$/;
const hosted = /^(ubuntu-(22\.04|24\.04|latest)|windows-(2022|2025|latest)|macos-(14|15|26|latest)(-intel)?)$/;
const pinned = /^actions\/(setup-(node|python|dotnet|go|java))@[0-9a-f]{40}$/;
const checkout = /^actions\/checkout@[0-9a-f]{40}$/;
const upload = /^actions\/upload-artifact@[0-9a-f]{40}$/;
const active = "steps.unit.outputs.selected == 'true' && steps.recover.outputs.found != 'true'";

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

export function repositoryPath(value, root = false) {
  if (root && value === '.') return value;
  requireValue(typeof value === 'string' && value.length && !/[\\:*?"<>|\x00-\x1f$]/.test(value)
    && value.split('/').every(part => part && !['.', '..', '.git'].includes(part.toLowerCase())),
    'Expected a literal repository-relative path');
  return value;
}

function shell(value) {
  requireValue(['bash','pwsh','sh','cmd','powershell'].includes(value), 'Select a supported shell');
  return value;
}

function runner(value) {
  requireValue(typeof value === 'string' && hosted.test(value), 'Select a GitHub-hosted runner for build isolation');
  return value;
}

function parseWorkflow(bytes) {
  const doc = YAML.parseDocument(bytes, {uniqueKeys:true});
  requireValue(!doc.errors.length, 'Invalid workflow YAML');
  return doc.toJS({maxAliasCount:0});
}

export function matrixValue(value, row) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/g, (_, field) => {
    requireValue(Object.hasOwn(row,field) && ['string','number','boolean'].includes(typeof row[field]), 'Unknown matrix value');
    return String(row[field]);
  });
}

// Actions supplies these values for each run, including a fresh attempt on rerun.
const runField={run_id:'id',run_number:'run_number',run_attempt:'run_attempt'};
const archiveField=/\$\{\{\s*(matrix\.[\w-]+|github\.(?:run_id|run_number|run_attempt))\s*\}\}/g;
export function supportedArchiveName(pattern) {
  return typeof pattern==='string' && !pattern.replace(archiveField,'').includes('${{');
}

export function runArchiveName(template,run) {
  if(!supportedArchiveName(template))return undefined;
  let complete=true;
  const name=template.replace(archiveField,(_,field)=>{
    const value=field.startsWith('github.') && run?.[runField[field.slice(7)]];
    if(!Number.isSafeInteger(value)||value<=0){complete=false;return '';}
    return String(value);
  });
  return complete?name:undefined;
}

export function matchesMatrixName(pattern,name) {
  if(typeof pattern!=='string'||typeof name!=='string')return false;
  const parts=pattern.split(/\$\{\{\s*matrix\.[\w-]+\s*\}\}/);
  if(parts.some(s=>s.includes('${{')))return false;
  if(parts.length===1)return parts[0]===name;
  if(!name.startsWith(parts[0])||!name.endsWith(parts.at(-1)))return false;
  let end=parts[0].length;
  for(const literal of parts.slice(1,-1)){
    const i=name.indexOf(literal,end+1);
    if(i<=end)return false;
    end=i+literal.length;
  }
  return end<name.length-parts.at(-1).length;
}

// Map a native upload to a stable selection. Ambiguous boundaries stay unselected.
export function observedArchiveTemplate(pattern,name,run) {
  if(!supportedArchiveName(pattern)||typeof name!=='string'||name.includes('${{'))return undefined;
  const tokens=pattern.matchAll(/\$\{\{\s*github\.(?:run_id|run_number|run_attempt)\s*\}\}/g);
  let from=0,start=0,template='';
  for(const token of tokens){
    const value=runArchiveName(token[0],run);
    if(value===undefined)return undefined;
    const prefix=pattern.slice(from,token.index);
    let boundary;
    for(let i=name.indexOf(value,start);i!==-1;i=name.indexOf(value,i+1)){
      if(!matchesMatrixName(prefix,name.slice(start,i)))continue;
      if(boundary!==undefined)return undefined;
      boundary=i;
    }
    if(boundary===undefined)return undefined;
    template+=name.slice(start,boundary)+token[0];
    start=boundary+value.length;from=token.index+token[0].length;
  }
  return matchesMatrixName(pattern.slice(from),name.slice(start))?template+name.slice(start):undefined;
}

export function staticMatrixRows(matrix) {
  if(!matrix) return [{}];
  if(typeof matrix!=='object') return null;
  const axes=Object.entries(matrix).filter(([k])=>k!=='include' && k!=='exclude');
  if(axes.some(([,options])=>!Array.isArray(options)) || !Array.isArray(matrix.include??[]) || !Array.isArray(matrix.exclude??[])) return null;
  const combinations=axes.reduce((rows,[k,options])=>rows.flatMap(row=>options.map(v=>({...row,[k]:v}))),axes.length?[{}]:[]);
  const base=combinations.filter(row=>!(matrix.exclude??[]).some(ex=>Object.entries(ex).every(([k,v])=>row[k]===v)));
  const rows=base.map(row=>({...row}));
  for(const extra of matrix.include??[]) {
    let merged=false;
    base.forEach((row,i)=>{
      if(axes.every(([k])=>!Object.hasOwn(extra,k) || extra[k]===row[k])) {
        Object.assign(rows[i],extra);merged=true;
      }
    });
    if(!merged) rows.push({...extra});
  }
  return rows;
}

// Static matching identifies an existing target. A native run supplies the artifact evidence separately.
export function selectWorkflow(bytes, selection) {
  const workflow = parseWorkflow(bytes);
  const job = workflow.jobs?.[selection.job];
  requireValue(job?.steps && !job.uses && !job.environment && !job.container && !job.services, 'Select a native build job');
  const row = selection.matrix ?? {};
  const rows=staticMatrixRows(job.strategy?.matrix);
  requireValue(rows && rows.some(r=>isDeepStrictEqual(r,row)), 'Matrix target requires a declared static row or native run evidence');
  const label = runner(matrixValue(job['runs-on'],row));
  requireValue(!job.if && !job.needs && !job.environment && !job.permissions?.['id-token'], 'An existing native run or a reviewed product entry is required for this job');
  const defaults = {...workflow.defaults?.run,...job.defaults?.run};
  const archives = job.steps.filter(step=>upload.test(step.uses));
  const selected = archives.filter(step=>matrixValue(step.with?.name,row) === selection.archive);
  requireValue(selected.length === 1, 'Select one declared archive');
  requireValue(Object.keys(selected[0].with??{}).every(k=>['name','path','retention-days','if-no-files-found','compression-level'].includes(k)), 'Archive options require a reviewed product entry');
  const output = repositoryPath(matrixValue(selected[0].with.path,row).replace(/\/$/,''));
  const steps = [];
  for (const step of job.steps) {
    requireValue(!step.if && !step.env && !job.env && !workflow.env && !step['continue-on-error'],
      'Conditional execution or environment requires a reviewed product entry');
    if (checkout.test(step.uses)) {
      requireValue(!Object.keys(step.with ?? {}).some(k=>!['persist-credentials','fetch-depth'].includes(k))
        && Number(step.with?.['fetch-depth'] ?? 1) === 1 && step.with?.['persist-credentials'] === false, 'Checkout must bind the same source without persisted credentials');
      continue;
    }
    if (upload.test(step.uses)) continue;
    if (step.uses) {
      requireValue(pinned.test(step.uses), 'Unsupported preparation step');
      const prepared = structuredClone(step);
      for (const [k,v] of Object.entries(prepared.with ?? {})) {
        prepared.with[k] = matrixValue(v,row);
        requireValue(!String(prepared.with[k]).includes('${{'), 'Unresolved preparation input');
        if (['global-json-file','node-version-file','python-version-file','go-version-file','cache-dependency-path'].includes(k))
          prepared.with[k] = 'product/' + repositoryPath(prepared.with[k]);
      }
      steps.push(prepared);
    } else {
      const code = matrixValue(step.run,row);
      requireValue(typeof code === 'string' && !code.includes('${{'), 'A reviewed literal build command is required');
      const directory = repositoryPath(matrixValue(step['working-directory'] ?? defaults['working-directory'] ?? '.',row),true);
      steps.push({name:step.name ?? 'Build',shell:shell(step.shell ?? defaults.shell ?? (label.startsWith('windows-')?'pwsh':'bash')),
        'working-directory':posix.join('product',directory),run:code});
    }
  }
  requireValue(job.steps.filter(s=>checkout.test(s.uses)).length===1 && checkout.test(job.steps[0].uses)
    && job.steps.indexOf(selected[0])>job.steps.findLastIndex(s=>s.run), 'Checkout and archive must bracket the packaging command');
  requireValue(steps.some(step=>step.run),'Missing build command');
  return {runner:label,steps,output};
}

export function scriptBuild(selection) {
  const label = runner(selection.runner);
  const directory = repositoryPath(selection.directory,true);
  const output = posix.join(directory,repositoryPath(selection.output,true));
  const steps = [];
  for (const [name,command] of [['Prepare tools',selection.prepare],['Package',selection.command]]) {
    if (name === 'Prepare tools' && !command) continue;
    requireValue(typeof command === 'string' && command.trim() && !command.includes('${{'), 'Enter the exact repository command');
    steps.push({name,shell:shell(selection.shell),'working-directory':posix.join('product',directory),run:command});
  }
  return {runner:label,steps,output};
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
    if(hosted.test(build['runs-on']))return build['runs-on'];
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
