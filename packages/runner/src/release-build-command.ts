import { preflightGenerationSource } from '../../core/src/release-generation-graph.js';
import { verifyBuildExecutionCapabilities } from './release-format-capabilities.js';
import { fetchBoundArtifactFile, type ArtifactBinding } from './artifact-handoff.js';
import {extractArtifactFile} from './artifact-file.js';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import { canonicalBuildManifest, matchBuildFiles } from '../../core/src/build-manifest.js';
import { planBuild, BuildContractError, type BuildPlan, type BuildManifest } from '../../core/src/build-manifest.js';
import { freezePersonalization } from '../../core/src/release-personalization.js';
import { releaseProfiles } from '../../../config/release-profiles.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, copyFile, constants } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GitHubClient, createInstallationToken, dispatchWorkflow } from '../../github/src/index.js';
import { highestStableRelease, readReleaseContributors } from '../../github/src/release-candidate.js';
import { canonicalReleaseJson, positiveId, receiptDigest, releaseAssert, releaseSha, type FrozenRelease } from '../../core/src/release-note-receipt.js';
import { releaseToolchain, releaseToolchainDigest, type ReleaseBuildState } from '../../core/src/release-build-request.js';
import { parseVersionFile } from '../../core/src/release-version.js';
import { ReleaseReceiptClient, refreshingReleaseToken } from './release-lifecycle.js';
import { freezeReleaseGitInput, type GitReleaseBoundary } from './release-git-input.js';
import { buildReleaseAssets, executeBuildCommand, isolatedBuildEnvironment } from './release-build.js';
import { nativeReleaseInspector } from './release-native.js';
import { collectFileBuildManifest } from './build-manifest.js';
import notesProfile from '../../../config/profiles/release-notes/common-v3.json' with { type: 'json' };
import catalog from '../../../config/repositories.json' with { type: 'json' };

const run = promisify(execFile);
const environment = (key: string) => { releaseAssert(process.env[key], 'ENV_' + key); return process.env[key]!; };
async function output(values: Record<string, string>) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k,v]) => `${k}=${v}\n`).join(''));
}
async function writeSeed(path: string, value: string | Buffer): Promise<void> {
  const bytes = Buffer.from(value);
  try { await writeFile(path, bytes, { flag: 'wx' }); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    releaseAssert((await readFile(path)).equals(bytes), 'SEED_CONFLICT');
  }
}
async function scoped(repositoryId: number, policySha: string, actions: false | 'read' | 'write' = false) {
  const getToken = refreshingReleaseToken(() => createInstallationToken({ appId: environment('APP_ID'), privateKey: environment('STEWARD_APP_PRIVATE_KEY'), installationId: Number(environment('INSTALLATION_ID')), repositoryId,
    permissions: actions ? { actions, metadata: 'read' } : { contents: 'read', metadata: 'read' }, policySha }));
  const token = await getToken();
  const transport: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${await getToken()}`);
    return fetch(input, { ...init, headers, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
  };
  return { token, transport, gh: new GitHubClient(token, 'https://api.github.com', transport, policySha) };
}
async function checkoutSource(fullName: string, sha: string, destination: string, token: string, home: string): Promise<void> {
  releaseAssert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) && releaseSha(sha), 'BUILD_SOURCE');
  const env = { ...isolatedBuildEnvironment(process.env, home), GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:' + token).toString('base64')}`, GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '' };
  try {
    await run('git', ['-c', 'init.templateDir=', 'clone', '--no-checkout', '--no-tags', `https://github.com/${fullName}.git`, destination], { env, timeout: 300000, windowsHide: true });
    await run('git', ['-C', destination, 'fetch', '--no-tags', 'origin', sha], { env, timeout: 300000, windowsHide: true });
    await run('git', ['-C', destination, 'update-ref', '--no-deref', 'HEAD', sha], { env, timeout: 30000, windowsHide: true });
  } catch { throw new Error('RN_BUILD_SOURCE_FETCH'); }
}
export function hostedBuildRunner(family: string): string {
  releaseAssert(family === 'windows' || family === 'linux','BUILD_RUNNER');
  return family === 'windows' ? 'windows-2025' : 'ubuntu-24.04';
}
export const inspectionManifestDigest=(manifest:BuildManifest)=>createHash('sha256').update(canonicalBuildManifest(manifest)).digest('hex');
export function encodeInspectionReport(binding:ArtifactBinding,archiveSha256:string,manifest:BuildManifest):string {
 const report=Buffer.from(canonicalReleaseJson({binding,archiveSha256,manifestSha256:inspectionManifestDigest(manifest)})).toString('base64');
 releaseAssert(report.length<=60000,'BUILD_REPORT_LIMIT');return report;
}
export async function releaseBuildCommand(args: Readonly<Record<string, string>>): Promise<void> {
  const required = (k: string) => { releaseAssert(args[k], 'ARGUMENT_' + k); return args[k]!; };
  const operation = required('operation'), policySha = required('policy-sha'); releaseAssert(releaseSha(policySha), 'POLICY');
  if (operation === 'inspect-artifact') {
    releaseAssert(!process.env.STEWARD_APP_PRIVATE_KEY && !process.env.COPILOT_GITHUB_TOKEN, 'BUILD_CREDENTIALS');
    const token = environment('ARTIFACT_READ_TOKEN'); delete process.env.ARTIFACT_READ_TOKEN;
    const binding: ArtifactBinding = JSON.parse(Buffer.from(environment('ARTIFACT_BINDING'), 'base64').toString('utf8'));
    const plan: BuildPlan = JSON.parse(Buffer.from(environment('BUILD_PLAN'), 'base64').toString('utf8'));
    releaseAssert(binding.policySha === policySha && plan.policySha === policySha, 'BUILD_POLICY');
    const home = await mkdtemp(join(tmpdir(), 'steward-artifact-isolated-')), assets = join(home, 'assets');
    const archive = await fetchBoundArtifactFile(new GitHubClient(token), fetch, token, binding,join(home,'artifact.zip'));
    try {await extractArtifactFile(archive.path,assets);} catch(error) {
      if(error instanceof Error && (error.message==='ARTIFACT_HANDOFF_INVALID'||(('code' in error) && ['Z_DATA_ERROR','Z_BUF_ERROR'].includes(String(error.code))))) {await output({verificationFailed:'true'});throw new BuildContractError('RN_BUILD_INVALID');}
      throw error;
    }
    let manifest: BuildManifest;
    try { manifest = await collectFileBuildManifest(plan, assets, nativeReleaseInspector(resolve(required('inspector')),home)); }
    catch(error) { if(error instanceof BuildContractError) await output({verificationFailed:'true'}); throw error; }
    const report=encodeInspectionReport(binding,archive.digest,manifest);
    await output({report}); return;
  }
  if (operation === 'plan-product') {
    const repositoryId = Number(required('repository-id')), target = required('target-sha'), buildId = required('build-id');
    releaseAssert(positiveId(repositoryId) && releaseSha(target), 'BUILD_IDENTITY');
    const configuration = (catalog.repositories as Record<string, any>)[String(repositoryId)];
    releaseAssert(configuration?.managed && configuration.builds?.[buildId], 'BUILD_CONFIGURATION');
    verifyBuildExecutionCapabilities(configuration.builds[buildId]);
    const auth = await scoped(repositoryId, policySha), repository = await auth.gh.request<any>('GET', `/repositories/${repositoryId}`);
    releaseAssert(repository.id === repositoryId && repository.full_name === configuration.fullName && repository.private === false, 'BUILD_SOURCE_VISIBILITY');
    const directory = resolve(required('output')), home = await mkdtemp(join(tmpdir(), 'steward-product-plan-')), source = join(home, 'source');
    await mkdir(directory, { recursive: true });
    await checkoutSource(repository.full_name, target, source, auth.token, home);
    const env = isolatedBuildEnvironment(process.env, home);
    const paths = (await run('git', ['-C', source, 'ls-tree', '--name-only', target], { env, encoding: 'utf8' })).stdout.split('\n');
    const version = paths.includes('VERSION') ? parseVersionFile((await run('git', ['-C', source, 'show', `${target}:VERSION`], { env, encoding: 'buffer' })).stdout).value : null;
    const unit = configuration.builds[buildId];
    const plan = await planBuild({ repositoryId, fullName: repository.full_name, buildId, profile: unit.profile, targetSha: target, policySha, version }, unit);
    await writeFile(join(directory, 'request.json'), canonicalReleaseJson(plan), { flag: 'wx' });
    await run('git', ['-C', source, 'bundle', 'create', join(directory, 'source.bundle'), 'HEAD'], { env, timeout: 300000, windowsHide: true });
    await output({ runner: hostedBuildRunner(plan.runnerFamily) }); return;
  }
  if (operation === 'execute' || operation === 'execute-product') {
    releaseAssert(!process.env.STEWARD_APP_PRIVATE_KEY && !process.env.COPILOT_GITHUB_TOKEN && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN, 'BUILD_CREDENTIALS');
    const input = JSON.parse(await readFile(resolve(required('request')), 'utf8'));
    const state = input as ReleaseBuildState;
    if (operation === 'execute') releaseAssert(state.status === 'running' && state.request.frozen.policySha === policySha && state.request.plans.length === 1, 'BUILD_REQUEST');
    const plan: BuildPlan = operation === 'execute' ? state.request.plans[0]! : input;
    releaseAssert(plan.policySha === policySha, 'BUILD_POLICY');
    const source = resolve(required('workspace')), assets = resolve(required('assets')), home = await mkdtemp(join(tmpdir(), 'steward-build-home-'));
    await mkdir(assets, { recursive: true });
    const env = isolatedBuildEnvironment(process.env, home);
    await run('git', ['-c', 'init.templateDir=', 'clone', '--no-checkout', resolve(required('source-bundle')), source], { env, timeout: 300000, windowsHide: true });
    await run('git', ['-C', source, '-c', 'core.hooksPath=', 'checkout', '--detach', plan.targetSha], { env, timeout: 300000, windowsHide: true });
    releaseAssert(process.platform === (plan.runnerFamily === 'windows' ? 'win32' : 'linux'), 'BUILD_RUNNER');
    const sdk = plan.profile === 'dotnet-assets-v1' || plan.inputs.runtime === 'pwsh' ? (await run('dotnet', ['--version'], { cwd: source, env, encoding: 'utf8' })).stdout.trim() : releaseToolchain.dotnet;
    const powershell = plan.profile === 'dotnet-assets-v1' || plan.inputs.runtime === 'pwsh' ? (await run('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { env, encoding: 'utf8' })).stdout.trim() : releaseToolchain.powershell;
    releaseAssert(process.version === 'v' + releaseToolchain.node && sdk === releaseToolchain.dotnet && powershell === releaseToolchain.powershell, 'BUILD_TOOLCHAIN');
    if (plan.profile === 'node-package-v1') releaseAssert((await run('npm', ['--version'], { env, encoding: 'utf8' })).stdout.trim() === releaseToolchain.npm, 'BUILD_TOOLCHAIN');
    if (plan.profile === 'oci-image-v1') {
      const docker = (await run('docker', ['version', '--format', '{{.Server.Version}}'], { env, encoding: 'utf8' })).stdout.trim();
      const buildx = (await run('docker', ['buildx', 'version'], { env, encoding: 'utf8' })).stdout.trim().split(/\s+/)[1];
      releaseAssert(docker === releaseToolchain.docker && buildx === 'v' + releaseToolchain.buildx, 'BUILD_TOOLCHAIN');
    }
    const manifest = await buildReleaseAssets(plan, { sourceDirectory: source, outputDirectory: assets, buildRunId: required('run-id') }, c => executeBuildCommand(c, env), nativeReleaseInspector(resolve(required('inspector')), home));
    await writeFile(resolve(required('output')), canonicalReleaseJson(manifest), { flag: 'wx' });
    if (operation === 'execute-product') await writeFile(resolve(required('output')) + '.execution.json', canonicalReleaseJson({ repositoryId: plan.repositoryId, targetSha: plan.targetSha, policySha, buildId: plan.buildId, buildRunId: required('run-id'), inputsSha256: plan.inputsSha256, toolchain: releaseToolchain, toolchainDigest: releaseToolchainDigest }), { flag: 'wx' });
    return;
  }
  if (operation === 'resolve') {
    const central = await scoped(1296724484, policySha, 'read'), runId = Number(required('run-id'));
    const job = await central.gh.request<any>('GET', `/repos/splrad/steward/actions/runs/${runId}`);
    releaseAssert(job.id === runId && job.repository?.id === 1296724484 && job.head_sha === policySha && job.path === '.github/workflows/release-build.yml' && job.event === 'workflow_dispatch' && job.status === 'completed', 'BUILD_RUN_PROVENANCE');
    const match = /^build:(\d+):(v\d+\.\d+\.\d+):([a-f0-9]{64})?:([a-f0-9]{64})?$/.exec(job.display_title); releaseAssert(match && !(match[3] && match[4]), 'BUILD_RUN_NAME');
    const repositoryId = Number(match[1]), tag = match[2]!, auth = await scoped(repositoryId, policySha);
    const receipts = new ReleaseReceiptClient(environment('RUNTIME_URL'), auth.token, repositoryId, tag, auth.transport);
    const state = await receipts.request<ReleaseBuildState | null>('build-request', { action: 'find', runId, attempt: job.run_attempt });
    if (!state) { await output({ ready: 'false' }); return; }
    if (job.conclusion !== 'success') {
      await receipts.request('build-request', { action: 'fail', key: state.request.key, runId, attempt: job.run_attempt }); await output({ ready: 'false' }); return;
    }
    const artifacts = await central.gh.request<any>('GET', `/repos/splrad/steward/actions/runs/${runId}/artifacts?per_page=100`);
    releaseAssert(artifacts.total_count <= 100, 'BUILD_ARTIFACT_LIMIT');
    if (state.request.plans.length === 0) {
      const seeds = artifacts.artifacts.filter((a: any) => a.name === `release-build-request-${job.run_attempt}` && !a.expired);
      releaseAssert(seeds.length === 1, 'BUILD_SEED_ARTIFACT');
      await receipts.request('build-request', { action: 'finish-seed', key: state.request.key, runId, attempt: job.run_attempt, artifactId: seeds[0].id });
      const writer = await scoped(1296724484, policySha, 'write');
      await dispatchWorkflow(writer.gh, { owner: 'splrad', repo: 'steward', workflow: 'release.yml', policySha,
        inputs: { repositoryId: String(repositoryId), targetTag: tag, operation: 'generate', bundleArtifactId: String(seeds[0].id), bundleRunId: String(runId) } });
      await output({ ready: 'false' }); return;
    }
    const found = artifacts.artifacts.filter((a: any) => a.name === `release-build-result-${job.run_attempt}` && !a.expired);
    releaseAssert(found.length === 1, 'BUILD_ARTIFACT');
    const binding: ArtifactBinding = {repositoryId:1296724484,fullName:'splrad/steward',workflowPath:'.github/workflows/release-build.yml',policySha,runId,attempt:job.run_attempt,artifactId:found[0].id,artifactName:found[0].name};
    releaseAssert(state.request.plans.length === 1, 'BUILD_SET');
    await output({binding:Buffer.from(canonicalReleaseJson(binding)).toString('base64'),plan:Buffer.from(canonicalReleaseJson(state.request.plans[0])).toString('base64')});
    await output({ ready: 'true', repositoryId: String(repositoryId), tag, key: state.request.key, artifactId: String(found[0].id), attempt: String(job.run_attempt), mode: state.request.mode }); return;
  }
  const repositoryId = Number(required('repository-id')), tag = required('target-tag');
  releaseAssert(positiveId(repositoryId) && /^v\d+\.\d+\.\d+$/.test(tag), 'BUILD_IDENTITY');
  const auth = await scoped(repositoryId, policySha), receipts = new ReleaseReceiptClient(environment('RUNTIME_URL'), auth.token, repositoryId, tag, auth.transport);
  if (operation === 'reject') {
    await receipts.request('build-request', { action: 'reject', key: required('request-key'), runId: Number(required('run-id')), attempt: Number(required('attempt')) }); return;
  }
  if (operation === 'plan') {
    const directory = resolve(required('output')), home = await mkdtemp(join(tmpdir(), 'steward-build-plan-')), source = join(home, 'source');
    await mkdir(directory, { recursive: true }); let state: ReleaseBuildState;
    if (args['request-key']) {
      state = await receipts.request('build-request', { action: 'get', key: args['request-key'] });
      await checkoutSource(state.request.frozen.fullName, state.request.frozen.productTargetSha, source, auth.token, home);
    } else {
      const repository = await auth.gh.request<any>('GET', `/repositories/${repositoryId}`), [owner, repo] = repository.full_name.split('/');
      releaseAssert(repository.id === repositoryId && repository.private === false, 'BUILD_SOURCE_VISIBILITY');
      const target = required('target-sha'); releaseAssert(releaseSha(target), 'BUILD_TARGET');
      await checkoutSource(repository.full_name, target, source, auth.token, home);
      const versionBytes = (await run('git', ['-C', source, 'show', `${target}:VERSION`], { encoding: 'buffer', maxBuffer: 1024, env: isolatedBuildEnvironment(process.env, home) })).stdout;
      releaseAssert('v' + parseVersionFile(versionBytes).value === tag, 'BUILD_VERSION');
      const latest = await highestStableRelease(auth.gh, owner, repo);
      let boundary: GitReleaseBoundary = { kind: 'full-tree' };
      if (latest) {
        let object = (await auth.gh.getGitRef(owner, repo, `tags/${latest.tag_name}`)).object;
        for (let i = 0; object.type === 'tag' && i < 5; i++) object = (await auth.gh.request<any>('GET', `/repos/${owner}/${repo}/git/tags/${object.sha}`)).object;
        releaseAssert(object.type === 'commit' && releaseSha(object.sha), 'BUILD_BOUNDARY');
        const env = isolatedBuildEnvironment(process.env, home);
        await run('git', ['-C', source, 'fetch', '--no-tags', 'origin', object.sha], { env, timeout: 300000, windowsHide: true });
        await run('git', ['-C', source, 'update-ref', `refs/tags/${latest.tag_name}`, object.sha], { env, timeout: 30000, windowsHide: true });
        boundary = { kind: 'tag', sha: object.sha, reference: latest.tag_name };
      }
      const frozenSource = freezeReleaseGitInput({ workspace: source, identity: { repositoryId, defaultBranch: repository.default_branch, targetSha: target, policySha }, targetTag: tag, boundary });
      // Freeze the same bounded generation graph before spending any build budget.
      preflightGenerationSource(frozenSource.inputSha256, policySha, Buffer.byteLength(frozenSource.bytes), frozenSource.input);
      releaseAssert(frozenSource.input.commits.length <= 100, 'CONTRIBUTOR_LIMIT');
      const authorIds = required('author-ids').split(',').map(Number); releaseAssert(authorIds.length > 0 && authorIds.every(positiveId), 'AUTHOR_IDENTITY');
      for (const id of authorIds) releaseAssert((await auth.gh.request<any>('GET', `/user/${id}`)).type === 'User', 'AUTHOR_IDENTITY');
      const contributorDeadline = AbortSignal.timeout(90_000);
      const contributorClient = new GitHubClient(auth.token, 'https://api.github.com', (input, init = {}) => auth.transport(input, { ...init, signal: contributorDeadline }), policySha);
      const people = await readReleaseContributors(contributorClient, owner, repo, frozenSource.input.commits);
      const compareUrl = boundary.kind === 'full-tree' ? null : `https://github.com/${repository.full_name}/compare/${boundary.reference}...${tag}`;
      const profileName = (catalog.repositories as Record<string, any>)[String(repositoryId)]?.delivery?.githubRelease?.profile;
      releaseAssert(!profileName || releaseProfiles[profileName], 'PERSONALIZATION_PROFILE');
      const personalization = freezePersonalization(repositoryId, repository.full_name, profileName ? releaseProfiles[profileName] : undefined);
      const frozen: FrozenRelease = { personalization, repositoryId, fullName: repository.full_name, defaultBranch: repository.default_branch, productTargetSha: target, productTree: frozenSource.input.productTree, policySha, targetTag: tag, title: tag,
        sourceDigest: frozenSource.inputSha256, evidenceDigest: '0'.repeat(64), templateDigest: receiptDigest(canonicalReleaseJson(notesProfile)), boundary, assets: [], build: null, manifests: [], toolchainDigest: releaseToolchainDigest,
        authorIds, contributors: [...people].map(([id, login]) => ({ id, login })), compareUrl, allowedLinks: compareUrl ? [compareUrl] : [] };
      await receipts.putObject(Buffer.from(frozenSource.bytes));
      state = await receipts.request('build-request', { action: 'prepare', frozen });
    }
    state = await receipts.request('build-request', { action: 'begin', key: state.request.key, runId: Number(required('run-id')), attempt: Number(required('attempt')) });
    if (state.request.plans.length === 0) {
      releaseAssert(state.request.mode === 'initial' && state.request.frozen.build === null
        && state.request.frozen.assets.length === 0, 'BUILD_SEED');
      await writeFile(join(directory, 'request.json'), canonicalReleaseJson(state), { flag: 'wx' });
      await writeSeed(join(directory, 'source.json'), await receipts.getObject(state.request.frozen.sourceDigest));
      await writeSeed(join(directory, 'frozen.json'), canonicalReleaseJson(state.request.frozen));
      await output({ runner: 'none' }); return;
    }
    await output({ runner: hostedBuildRunner(state.request.plans[0]!.runnerFamily) });
    await writeFile(join(directory, 'request.json'), canonicalReleaseJson(state), { flag: 'wx' });
    await run('git', ['-C', source, 'bundle', 'create', join(directory, 'source.bundle'), 'HEAD'], { env: isolatedBuildEnvironment(process.env, home), timeout: 300000, maxBuffer: 1024 * 1024, windowsHide: true }); return;
  }
  if (operation === 'accept') {
    const key = required('request-key'), state = await receipts.request<ReleaseBuildState>('build-request', { action: 'get', key });
    releaseAssert(state.request.plans.length === 1, 'BUILD_SET');
    const encoded=environment('ARTIFACT_REPORT'); releaseAssert(encoded.length<=60000 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),'BUILD_REPORT');
    const report=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
    releaseAssert(report && Object.keys(report).sort().join(',')==='archiveSha256,binding,manifestSha256','BUILD_REPORT');
    const binding:ArtifactBinding={repositoryId:1296724484,fullName:'splrad/steward',workflowPath:'.github/workflows/release-build.yml',policySha,runId:Number(required('run-id')),attempt:Number(required('attempt')),artifactId:Number(required('artifact-id')),artifactName:'release-build-result-'+required('attempt')};
    releaseAssert(canonicalReleaseJson(report.binding)===canonicalReleaseJson(binding),'BUILD_REPORT_BINDING');
    const central=await scoped(1296724484,policySha,'read');
    // Only bounded archive parsing and hashing occur with credentials. No native inspection or product code runs here.
    const intake=await mkdtemp(join(tmpdir(),'steward-artifact-accept-'));
    const archive=await fetchBoundArtifactFile(central.gh,fetch,central.token,binding,join(intake,'artifact.zip')), files=await extractArtifactFile(archive.path,join(intake,'files'));
    releaseAssert(report.archiveSha256===archive.digest,'BUILD_REPORT_DIGEST');
    const plan=state.request.plans[0]!, assignments=matchBuildFiles(plan,[...files.keys()]);
    const manifest:BuildManifest={schemaVersion:1,repositoryId:plan.repositoryId,fullName:plan.fullName,buildId:plan.buildId,profile:plan.profile,targetSha:plan.targetSha,policySha:plan.policySha,version:plan.version,inputsSha256:plan.inputsSha256,artifacts:assignments.map(a=>({...a,kind:'file' as const,size:files.get(a.file)!.size,sha256:files.get(a.file)!.sha256}))};
    releaseAssert(inspectionManifestDigest(manifest)===report.manifestSha256,'BUILD_REPORT_MANIFEST');
    const assets=resolve(required('assets')); await mkdir(assets,{recursive:true});
    for(const [name,file] of files) {
      try{await copyFile(file.path,join(assets,name),constants.COPYFILE_EXCL);}catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        const hash=createHash('sha256');let size=0;for await(const chunk of createReadStream(join(assets,name))){size+=chunk.length;hash.update(chunk);}
        releaseAssert(size===file.size&&hash.digest('hex')===file.sha256,'SEED_CONFLICT');
      }
    }
    if (state.request.mode === 'initial') {
      const directory = resolve(required('output')); await mkdir(directory, { recursive: true });
      // Stage the complete seed before committing acceptance. The runtime independently
      // verifies this build identity against GitHub in finish before continuation.
      const build = { runId: Number(required('run-id')), artifactId: Number(required('artifact-id')), artifactName: `release-build-result-${required('attempt')}`, headSha: policySha };
      const frozen: FrozenRelease = { ...state.request.frozen, build, manifests: [manifest], assets: manifest.artifacts.map(a => { releaseAssert(a.kind === 'file', 'BUILD_FILE'); return { name: a.file, size: a.size, sha256: a.sha256 }; }) };
      const bytes = await receipts.getObject(frozen.sourceDigest);
      await writeSeed(join(directory, 'source.json'), bytes); await writeSeed(join(directory, 'frozen.json'), canonicalReleaseJson(frozen));
    }
    try { await receipts.request<ReleaseBuildState>('build-request', { action: 'finish', key, runId: Number(required('run-id')), attempt: Number(required('attempt')), artifactId: Number(required('artifact-id')), manifests: [manifest], toolchainDigest: releaseToolchainDigest }); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('REBUILD_CHANGED_REVIEW_REQUIRED')) throw error;
      const saved = await receipts.request<ReleaseBuildState>('build-request', { action: 'get', key });
      releaseAssert(saved.error === 'rebuild-changed-review-required' && saved.artifact?.artifactId === Number(required('artifact-id')), 'REBUILD_RESULT');
      await output({ reviewRequired: 'true' }); return;
    }
    return;
  }
  if (operation === 'continue') {
    const state = await receipts.request<ReleaseBuildState>('build-request', { action: 'get', key: required('request-key') });
    releaseAssert(state.status === 'accepted', 'BUILD_NOT_ACCEPTED');
    const central = await scoped(1296724484, policySha, 'write');
    await dispatchWorkflow(central.gh, { owner: 'splrad', repo: 'steward', workflow: 'release.yml', policySha,
      inputs: { repositoryId: String(repositoryId), targetTag: tag, operation: state.request.mode === 'initial' ? 'generate' : ((catalog.repositories as Record<string, any>)[String(repositoryId)]?.delivery?.githubRelease?.state === 'active' ? 'reconcile' : 'inspect'), ...(state.request.mode === 'initial' ? { bundleArtifactId: required('artifact-id'), bundleRunId: required('run-id') } : {}) } }); return;
  }
  throw new Error('RN_BUILD_OPERATION');
}
