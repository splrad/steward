import { bindPipelineRun, parsePipelineRecord, pipelineSource, type BuildPipelineRecord } from './release-pipeline-record.js';
import { sealProductArtifacts, validateProductManifest } from './release-artifacts.js';
import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, appendFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipelineRecoverCycleFinal, pipelineIdentity, pipelineChannelIdentity, pipelineChannelDownload, pipelineProducers, pipelineDownloadProducers, pipelineCollect, pipelineInspect, pipelineNotes, pipelinePublish, pipelineVerifyPublished, pipelineDownloadPhase } from './release-pipeline.js';
import { generateReleaseSbom } from './release-sbom.js';
import { assertReleaseJobResults, productBusinessResults, channelBusinessResults, channelReadyTargets, channelPreparationResults, type ChannelProbe } from './release-run.js';
import { nativePages, findFrozenFinal } from './release-pipeline.js';
import { nativeRunFact, jobFact } from './native-release-evidence.js';
import { nativeGhCommand, type GhCommand } from './gh-release.js';
import { createHash } from 'node:crypto';
import { decodeReleaseRecord, type CycleRecord } from '../../core/src/release-observation.js';
import { inspectNativeCycle } from './native-release-evidence.js';
import { decodeBuildJson } from '../../core/src/build-manifest.js';

export const nativeCommands = new Set(['release', 'release-pipeline']);
const allowed: Record<string, string[]> = {
  'release inspect': ['repository', 'context', 'output'],
  'release candidate': ['context', 'output'],
  'release dispatch-build': ['context', 'output'],
  'release publish': ['context', 'output'],
  'release dispatch-channel': ['context', 'output'],
  'release observe-channel': ['context', 'output'],
  'release rerun': ['context', 'output'],
  'release-pipeline gates': ['mode', 'results', 'output'],
  'release-pipeline identity': ['cycle-id', 'operation-key', 'source-sha', 'controller-sha', 'source-dir', 'controller-dir', 'state-dir', 'output'],
  'release-pipeline recover': ['record', 'unit', 'source-dir', 'controller-dir', 'state-dir', 'directory', 'home', 'output'],
  'release-pipeline evidence': ['record', 'unit', 'source-dir', 'controller-dir', 'state-dir', 'directory', 'home', 'output'],
  'release-pipeline result': ['record', 'unit', 'controller-dir', 'state-dir', 'job-name', 'objects', 'output'],
  'release-pipeline collect': ['record', 'unit', 'source-dir', 'controller-dir', 'state-dir', 'raw-dir', 'output-dir', 'home', 'output'],
  'release-pipeline inspect': ['record', 'unit', 'source-dir', 'controller-dir', 'state-dir', 'selection', 'directory', 'home', 'staging', 'sbom-home', 'output'],
  'release-pipeline download': ['record', 'unit', 'source-dir', 'controller-dir', 'state-dir', 'artifact-id', 'digest', 'phase', 'directory', 'home', 'output'],
  'release-pipeline seal': ['record', 'unit', 'source-dir', 'controller-dir', 'state-dir', 'directory', 'manifest', 'output'],
  'release-pipeline publish': ['record', 'unit', 'app-bot-id', 'directory', 'output'],
  'release-pipeline verify': ['record', 'unit', 'app-bot-id', 'directory', 'output'],
  'release-pipeline channel-source': ['inputs', 'state-dir', 'controller-dir', 'stage', 'output'],
  'release-pipeline channel-download': ['inputs', 'state-dir', 'controller-dir', 'unit', 'channel', 'directory', 'output'],
  'release-pipeline channel-probe': ['inputs', 'state-dir', 'controller-dir', 'reads', 'output'],
  'release-pipeline channel-ready': ['inputs', 'state-dir', 'controller-dir', 'reads', 'output'],
  'release-pipeline channel-result': ['inputs', 'state-dir', 'controller-dir', 'unit', 'channel', 'job-name', 'objects', 'output'],
};
export function parseNativeInvocation(argv: readonly string[]) {
  const command = `${argv[0]} ${argv[1]}`, fields = allowed[command];
  if (!fields) throw new Error('NATIVE_CLI: unknown command');
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!; if (!flag.startsWith('--') || !fields.includes(flag.slice(2)) || Object.hasOwn(args, flag.slice(2))) throw new Error('NATIVE_CLI: unknown or duplicate flag');
    const name = flag.slice(2);
    if (name === 'offline') { args[name] = 'true'; continue; }
    const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`NATIVE_CLI: missing value for ${name}`);
    args[name] = value;
  }
  const optional = command.endsWith(' targets') ? ['repository'] : command === 'release inspect' ? ['context'] : [];
  for (const field of fields) if (!optional.includes(field) && !args[field]) throw new Error(`NATIVE_CLI: missing ${field}`);
  return { command, args };
}
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
export async function nativeReleaseCli(argv: readonly string[]) {
  const { command, args } = parseNativeInvocation(argv), required = (name: string) => args[name]!;
  if (command === 'release inspect') {
    const result = await inspectNativeReleaseRecords(required('repository'));
    if (args.context) {
      const context=decodeBuildJson(await readFile(args.context)) as Parameters<typeof inspectNativeCycle>[0];
      if(context.repository!==required('repository') || !result.records.some(record=>record.path===`cycles/${context.cycle.id}.json` && isDeepStrictEqual(record.value,context.cycle)))
        throw new Error('NATIVE_CLI: context must match native cycle');
      const evidence=await inspectNativeCycle(context);
      await writeFile(required('output'),JSON.stringify({...result,evidence},null,2)+'\n',{flag:'wx'});
      return;
    }
    await writeFile(required('output'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return;
  }
  if(command.startsWith('release ')) {
    // The fixed Git bridge is shipped beside this bundle; state cannot select a script or operation.
    const checkout=await realpath(process.cwd());
    try {await promisify(execFile)(process.execPath,[join(checkout,'scripts','release-record.mjs'),command.slice(8),'--input',resolve(required('context')),'--output',resolve(required('output'))],
      {windowsHide:true,maxBuffer:1024*1024,env:{...process.env,STEWARD_STATE_TOKEN:process.env.GH_TOKEN}});}
    catch(error) {if((error as {code?:number}).code!==75)throw new Error('NATIVE_CLI: release connection failed');process.exitCode=75;}
    return;
  }
  if(command.startsWith('release-pipeline channel-')) {
    const stateDirectory=resolve(required('state-dir')),controllerDirectory=resolve(required('controller-dir')),statePath=resolve(required('output')+'.state.json');
    const git=async(argv:string[])=>(await promisify(execFile)('git',['--no-replace-objects','-C',stateDirectory,...argv],{windowsHide:true,timeout:120_000,maxBuffer:1024*1024})).stdout.trim();
    await git(['fetch','--no-tags','--no-recurse-submodules','origin','refs/heads/steward/release-state']);
    const head=await git(['rev-parse','FETCH_HEAD']);if(!/^[a-f0-9]{40}$/.test(head))throw new Error('NATIVE_CLI: state head');
    await git(['update-ref','refs/heads/steward/release-state',head]);
    await promisify(execFile)(process.execPath,[join(controllerDirectory,'scripts/release-record.mjs'),'read','--directory',stateDirectory,'--target-ref','steward/release-state',
      '--repository-id',process.env.GITHUB_REPOSITORY_ID??'','--output',statePath],{windowsHide:true,maxBuffer:1024*1024});
    const stage=command==='release-pipeline channel-source'?required('stage'):'admit';
    if(!['source','admit'].includes(stage))throw new Error('NATIVE_CLI: channel stage');
    const selection=await pipelineChannelIdentity(await json(required('inputs')),await json(statePath),process.env,undefined,undefined,stage as 'source'|'admit');
    if(selection.status!=='ADMITTED'&&selection.status!=='OBSERVE'&&selection.status!=='SOURCE') {
      if(selection.status==='REJECTED'&&selection.reason==='SOURCE_REF_MOVED')process.stdout.write('STEWARD_SOURCE_REJECTED '+JSON.stringify(selection)+'\n');
      await writeFile(required('output'),JSON.stringify(selection)+'\n',{flag:'wx'});process.exitCode=['UNKNOWN','NOT_BOUND'].includes(selection.status)?75:1;return;
    }
    const {context,targets,run}=selection;let readyTargets=targets;
    let result:unknown=selection;
    if(command==='release-pipeline channel-download') {
      const target=targets.find(value=>value.unitId===required('unit')&&value.channelId===required('channel'));
      if(selection.status!=='ADMITTED'||!target)throw new Error('NATIVE_CLI: channel business admission');
      result=await pipelineChannelDownload(context,target,required('directory'));
    } else if(command==='release-pipeline channel-probe') {
      if(selection.status!=='OBSERVE')throw new Error('NATIVE_CLI: read-only probe mode');
      const items=await json(required('reads'));
      const report:ChannelProbe={schemaVersion:1,cycleId:context.cycle.id,sourceSha:context.cycle.sourceSha,executionSha:run.headSha,
        controllerSha:context.cycle.controllerSha,targetsDigest:selection.targetsDigest,nativeRunId:run.id,runAttempt:run.runAttempt,items};
      if(!Array.isArray(items)||items.length!==targets.length||Buffer.byteLength(JSON.stringify(report))>4096+4096*targets.length)throw new Error('NATIVE_CLI: probe payload bound');
      result=report;
    } else if(command==='release-pipeline channel-ready') {
      if(selection.status!=='ADMITTED'||!selection.request)throw new Error('NATIVE_CLI: preparation identity');
      const now=new Date().toISOString(),ready=channelReadyTargets(context,targets,selection.request.purpose==='channel-submit'?'submit':'verify',await json(required('reads')),now);
      const jobs=await nativePages(`repos/${context.repository}/actions/runs/${run.id}/attempts/${run.runAttempt}/jobs?per_page=100`,'jobs');
      const matches=jobs.filter(job=>job.name==='channel-prepare');if(matches.length!==1)throw new Error('NATIVE_CLI: preparation job');
      for(const receipt of channelPreparationResults(context,selection.request,run,jobFact(matches[0]),ready.ready,now))process.stdout.write('STEWARD_RESULT '+JSON.stringify(receipt)+'\n');
      result=ready;readyTargets=ready.ready;
    } else if(command==='release-pipeline channel-result') {
      const target=targets.find(value=>value.unitId===required('unit')&&value.channelId===required('channel'));
      if(!target||!selection.request)throw new Error('NATIVE_CLI: channel result source');
      let jobs:any[]=[];
      for(let retry=0;retry<6;retry++) {
        jobs=await nativePages(`repos/${context.repository}/actions/runs/${run.id}/attempts/${run.runAttempt}/jobs?per_page=100`,'jobs');
        if(jobs.some(job=>job.name===required('job-name')&&job.steps.some((step:any)=>step.name.startsWith('business-')&&step.completed_at)))break;
        if(retry<5)await new Promise(resolve=>setTimeout(resolve,2000));
      }
      const matches=jobs.filter(job=>job.name===required('job-name'));if(matches.length!==1)throw new Error('NATIVE_CLI: channel job identity');
      const receipts=channelBusinessResults(context,selection.request,run,jobFact(matches[0]),target,new Date().toISOString(),JSON.parse(required('objects')));
      for(const receipt of receipts)process.stdout.write('STEWARD_RESULT '+JSON.stringify(receipt)+'\n');result={receipts};
    }
    await writeFile(required('output'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    if(process.env.GITHUB_OUTPUT&&['release-pipeline channel-source','release-pipeline channel-ready'].includes(command)) {
      const matrix=readyTargets.map(target=>({...target,location:selection.delivery.units.find(unit=>unit.id===target.unitId)!.channels.find(channel=>channel.id===target.channelId)!.location}));
      await appendFile(process.env.GITHUB_OUTPUT,`targets_digest=${selection.targetsDigest}\nmatrix=${JSON.stringify({include:matrix})}\nhas_work=${matrix.length>0}\n`);
      for(const [id,name] of [['ghcr-assets','ghcr'],['winget','winget']]) {
        const rows=matrix.filter(target=>target.channelId===id);
        await appendFile(process.env.GITHUB_OUTPUT,`${name}_matrix=${JSON.stringify({include:rows})}\nhas_${name}=${rows.length>0}\n`);
      }
    }
    return;
  }
  if (command.startsWith('release-pipeline ')) {
    let result: unknown;
    if (command === 'release-pipeline publish' || command === 'release-pipeline verify') {
      const record = parsePipelineRecord(await json(required('record')));
      if (record.kind !== 'publish' || !/^[1-9][0-9]*$/.test(required('app-bot-id'))) throw new Error('NATIVE_CLI: publish identity');
      result = command.endsWith(' publish') ? await pipelinePublish(record, required('unit'), required('directory'), Number(required('app-bot-id')))
        : await pipelineVerifyPublished(record, required('unit'), required('directory'), Number(required('app-bot-id')));
    } else if (command === 'release-pipeline gates') {
      const mode = required('mode'); if (!['build', 'verify', 'product'].includes(mode)) throw new Error('NATIVE_CLI: invalid release mode');
      const needs = JSON.parse(required('results'));
      assertReleaseJobResults(mode as 'build' | 'verify' | 'product', 'none', Object.fromEntries(Object.entries(needs).map(([name, value]) => [name, (value as { result: string }).result])));
      result = { mode, verifiedJobResults: true };
    } else {
      const controllerDirectory = resolve(required('controller-dir')), statePath = resolve(required('output') + '.state.json');
      const stateDirectory = resolve(required('state-dir'));
      // Refresh only the local protected-state reference before each read. Product/source refs never move here.
      const gitState = async (argv: string[]) => (await promisify(execFile)('git', ['--no-replace-objects', '-C', stateDirectory, ...argv],
        { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim();
      await gitState(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', 'refs/heads/steward/release-state']);
      const fetchedState = await gitState(['rev-parse', 'FETCH_HEAD']);
      if (!/^[a-f0-9]{40}$/.test(fetchedState)) throw new Error('RELEASE_RECORD: fetched state identity');
      await gitState(['update-ref', 'refs/heads/steward/release-state', fetchedState]);
      await promisify(execFile)(process.execPath, [join(controllerDirectory, 'scripts/release-record.mjs'), 'read',
        '--directory', resolve(required('state-dir')), '--target-ref', 'steward/release-state',
        '--repository-id', process.env.GITHUB_REPOSITORY_ID ?? '', '--output', statePath], { windowsHide: true, maxBuffer: 1024 * 1024 });
      const state = await json(statePath);
      if (command === 'release-pipeline result') {
        const record = parsePipelineRecord(await json(required('record')));
        if (record.kind !== 'build') throw new Error('RELEASE_RECORD: build input required');
        const cycle = state.cycles.find((item: { value: CycleRecord }) => item.value.id === record.cycleId)?.value as CycleRecord;
        const request = cycle?.dispatches.find(item => item.requestKey === record.requestKey); if (!request) throw new Error('RELEASE_RECORD: result request');
        const get = async (path: string) => JSON.parse(await nativeGhCommand(['api', '--method', 'GET', path]));
        const ref = await get(`repos/${record.fullName}/git/ref/heads/steward/release-state`);
        if (ref.object?.sha !== state.head) throw new Error('RELEASE_RECORD: result state source');
        const bot = await get('users/splrad-steward%5Bbot%5D');
        if (bot.type !== 'Bot' || bot.login !== 'splrad-steward[bot]') throw new Error('RELEASE_RECORD: result App bot');
        const run = nativeRunFact(await get(`repos/${record.fullName}/actions/runs/${record.runId}`));
        if (String(run.id) !== process.env.GITHUB_RUN_ID || String(run.runAttempt) !== process.env.GITHUB_RUN_ATTEMPT) throw new Error('RELEASE_RECORD: result current run');
        let selected: any[] = [];
        for (let read = 0; read < 6; read++) {
          const jobs = await nativePages(`repos/${record.fullName}/actions/runs/${run.id}/attempts/${run.runAttempt}/jobs?per_page=100`, 'jobs');
          selected = jobs.filter(job => job.name === required('job-name'));
          if (selected.length === 1 && selected[0].steps.some((step: any) => step.name.startsWith('business-') && step.completed_at)) break;
          if (read < 5) await new Promise(accept => setTimeout(accept, 2000));
        }
        const source = pipelineSource(record, required('unit'));
        if (selected.length !== 1 || ![...source.unit.builds.map(build => build.jobName), `evidence/${source.unit.id} / inspect`, `freeze/${source.unit.id}`].includes(required('job-name')))
          throw new Error('RELEASE_RECORD: result job identity');
        const notStarted: number[] = [];
        if (required('job-name') === `evidence/${source.unit.id} / inspect`) {
          const selectionPath = join(dirname(resolve(required('output'))), 'selection.json');
          try {
            const selection = await json(selectionPath);
            if (['UNKNOWN', 'NOT_BOUND', 'REJECTED'].includes(selection.status))
              notStarted.push(...selected[0].steps.filter((step: any) => step.name === 'business-evidence').map((step: any) => step.number));
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const results = productBusinessResults({ repository: record.fullName, repositoryId: record.repositoryId, appBotId: bot.id, cycle }, request, run,
          jobFact(selected[0]), required('unit'), new Date().toISOString(), JSON.parse(required('objects')), notStarted);
        if (!results.length) throw new Error('RELEASE_RECORD: native result steps not visible');
        await writeFile(required('output'), JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
        for (const value of results) process.stdout.write(`STEWARD_RESULT ${JSON.stringify(value)}\n`);
        return;
      }
      let prior: BuildPipelineRecord | null = null;
      if (command !== 'release-pipeline identity') {
        const decoded = parsePipelineRecord(await json(required('record')));
        if (decoded.kind !== 'build') throw new Error('RELEASE_RECORD: build input required'); prior = decoded;
        // The actual retry is observed, never reserved in persisted state.
        prior.runAttempt = bindPipelineRun(pipelineSource(prior, required('unit')), {
          repositoryId: process.env.GITHUB_REPOSITORY_ID, fullName: process.env.GITHUB_REPOSITORY, sourceSha: process.env.GITHUB_SHA,
          runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, ref: process.env.GITHUB_REF, event: process.env.GITHUB_EVENT_NAME,
        }).attempt;
      }
      const operation = prior ? state.cycles.find((item: { value: CycleRecord }) => item.value.id === prior.cycleId)?.value.dispatches
        .find((item: CycleRecord['dispatches'][number]) => item.requestKey === prior.requestKey)?.operationKey : required('operation-key');
      const admission = await pipelineIdentity({ cycleId: prior?.cycleId ?? required('cycle-id'), operationKey: operation,
        sourceSha: prior?.sourceSha ?? required('source-sha'), controllerSha: prior?.controllerSha ?? required('controller-sha'),
        sourceDirectory: resolve(required('source-dir')), controllerDirectory, state });
      if (admission.status !== 'ADMITTED') {
        await writeFile(required('output'), JSON.stringify(admission, null, 2) + '\n', { flag: 'wx' });
        process.exitCode = admission.status === 'REJECTED' ? 1 : 75; return;
      }
      const record = admission.record;
      if (prior && !isDeepStrictEqual(prior, record)) throw new Error('RELEASE_RECORD: frozen input drift');
      if (command === 'release-pipeline identity') {
        result = record;
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `record=${JSON.stringify(record)}\nunits=${JSON.stringify({ include: record.units.map(unit => ({ unit: unit.id })) })}\n`);
      } else {
        const source = pipelineSource(record, required('unit'));
        if (command === 'release-pipeline recover') {
          const cycle = state.cycles.find((item: { value: CycleRecord }) => item.value.id === record.cycleId)?.value;
          const recovered = await pipelineRecoverCycleFinal(record, required('unit'), cycle, resolve(required('directory')), controllerDirectory, resolve(required('home')));
          result = recovered;
          if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `found=${recovered.found}\n${recovered.found ? `artifact_id=${recovered.artifactId}\ndigest=${recovered.digest}\n` : ''}`);
        } else if (command === 'release-pipeline evidence') {
          const found = await findFrozenFinal(source, nativePages, 'evidence'); if (!found) throw new Error('RELEASE_RECORD: evidence artifact missing');
          result = await pipelineDownloadPhase(source, found.artifactId, found.digest, 'evidence', required('directory'), controllerDirectory, required('home'));
        } else if (command === 'release-pipeline collect') {
          const selection = await pipelineProducers(source);
          await pipelineDownloadProducers(source, selection, required('raw-dir'), controllerDirectory, required('home'));
          await pipelineCollect(source, selection, required('raw-dir'), required('output-dir')); result = selection;
        } else if (command === 'release-pipeline inspect') {
          result = await pipelineInspect(record, required('unit'), await json(required('selection')), required('directory'), controllerDirectory, required('home'));
          await generateReleaseSbom(record, resolve(required('directory')), resolve(required('source-dir')), controllerDirectory, resolve(required('staging')), resolve(required('sbom-home')));
          await writeFile(join(required('directory'), 'release-notes.md'), await pipelineNotes(record, required('unit'), required('source-dir')), { flag: 'wx' });
        } else if (command === 'release-pipeline download') {
          result = await pipelineDownloadPhase(source, Number(required('artifact-id')), required('digest'), required('phase') as 'collected' | 'final',
            resolve(required('directory')), controllerDirectory, resolve(required('home')));
        } else {
          const manifest = await json(required('manifest')); validateProductManifest(manifest);
          if (manifest.repositoryId !== record.repositoryId || manifest.runId !== record.runId || manifest.attempt !== record.runAttempt
            || manifest.sourceSha !== record.sourceSha || manifest.controllerSha !== record.controllerSha || manifest.unitId !== source.unit.id
            || manifest.cycleId !== record.cycleId || manifest.requestKey !== record.requestKey) throw new Error('RELEASE_RECORD: seal source');
          result = await sealProductArtifacts(required('directory'), manifest);
        }
      }
    }
    await writeFile(required('output'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return;
  }
  throw new Error('NATIVE_CLI: unknown command');
}

/** Read-only fixed entry. Persisted records locate facts; they never grant completion. */
export async function inspectNativeReleaseRecords(repository: string, gh: GhCommand = nativeGhCommand) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$(?![\s\S])/.test(repository) || repository.split('/').some(part=>part==='.'||part==='..')) throw new Error('RELEASE_INSPECT: repository');
  const read = async (path: string) => JSON.parse(await gh(['api','--method','GET',`repos/${repository}${path?'/'+path:''}`]));
  const records: {path:string;blobSha:string;value:unknown}[]=[];
  try {
    const repo=await read('');
    if (!Number.isSafeInteger(repo.id) || repo.id<1 || repo.full_name!==repository || typeof repo.default_branch!=='string') throw new Error('RELEASE_INSPECT: repository identity');
    const base=await read(`commits/${encodeURIComponent(repo.default_branch)}`);
    const state=await read('git/ref/heads/steward/release-state');
    if (state.ref!=='refs/heads/steward/release-state' || state.object?.type!=='commit' || !/^[a-f0-9]{40}$/.test(state.object.sha)) throw new Error('RELEASE_INSPECT: state ref');
    const commit=await read(`git/commits/${state.object.sha}`);
    if (commit.sha!==state.object.sha || !/^[a-f0-9]{40}$/.test(commit.tree?.sha)) throw new Error('RELEASE_INSPECT: commit');
    const tree=await read(`git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated!==false || !Array.isArray(tree.tree)) throw new Error('RELEASE_INSPECT: incomplete tree');
    const files=tree.tree.filter((entry:{path:string})=>entry.path==='state.json'||entry.path.startsWith('cycles/'));
    if (!files.some((entry:{path:string})=>entry.path==='state.json')) throw new Error('RELEASE_INSPECT: missing repository record');
    for (const file of files) {
      if (file.type==='tree') continue;
      if (file.mode!=='100644' || file.type!=='blob' || !/^[a-f0-9]{40}$/.test(file.sha)
        || file.path!=='state.json' && !/^cycles\/pr-[1-9][0-9]*-[a-f0-9]{40}\.json$/.test(file.path)) throw new Error('RELEASE_INSPECT: record path');
      const blob=await read(`git/blobs/${file.sha}`);
      if (blob.sha!==file.sha || blob.encoding!=='base64' || typeof blob.content!=='string' || blob.size>512*1024) throw new Error('RELEASE_INSPECT: blob');
      const bytes=Buffer.from(blob.content,'base64');
      if (bytes.length!==blob.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==file.sha) throw new Error('RELEASE_INSPECT: blob bytes');
      const value=file.path==='state.json'?decodeReleaseRecord('repository',bytes):decodeReleaseRecord('cycle',bytes);
      if (file.path==='state.json' ? 'repositoryId' in value && value.repositoryId!==repo.id : file.path!==`cycles/${(value as CycleRecord).id}.json`) throw new Error('RELEASE_INSPECT: record identity');
      records.push({path:file.path,blobSha:file.sha,value});
    }
    const stateAfter=await read('git/ref/heads/steward/release-state'),baseAfter=await read(`commits/${encodeURIComponent(repo.default_branch)}`);
    if (stateAfter.object?.sha!==state.object.sha || baseAfter.sha!==base.sha) throw new Error('RELEASE_INSPECT: source moved');
    return {repositoryId:repo.id,repository:repo.full_name,defaultBranch:repo.default_branch,defaultSha:base.sha,stateHead:state.object.sha,records,
      completion:{result:'UNKNOWN',reason:'NATIVE_EFFECT_RECONCILIATION_REQUIRED'}};
  } catch (error) {
    // Absence, 403, rate limits and unsupported/corrupt records cannot imply IDLE
    // or a successful observation. Native history recovery remains an explicit operation.
    return {repository,records,completion:{result:'UNKNOWN',reason:error instanceof Error && /^RELEASE_(?:INSPECT|OBSERVATION):/.test(error.message)
      ?error.message:'NATIVE_STATE_READ_UNAVAILABLE'}};
  }
}
