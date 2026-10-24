import { parsePipelineRecord } from './release-pipeline-record.js';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { parseRepositoryCatalog } from '../../core/src/repository-policy.js';
import { validateReleaseSource, type AdmissionInput } from './release-admission.js';
import { localGitSnapshot, previewManagedSync, validateOnboardingManifest, type OnboardingManifest, type SourceRule } from './managed-sync-preview.js';
import { NativeControlPlane } from './native-control-plane.js';
import { NativeReleasePlanner } from './release-plan.js';
import { applyManagedPreview } from './managed-sync-apply.js';
import { pipelineRecoverFinal, pipelineIdentity, pipelineBuild, pipelineProducers, pipelineDownloadProducers, pipelineCollect, pipelineInspect, pipelineNotes, pipelineSeal, pipelinePublish, pipelineVerifyPublished, pipelineDownloadPhase, type PipelineRecord } from './release-pipeline.js';
import { generateReleaseSbom } from './release-sbom.js';
import { parseManagedFileConfig } from './managed-file-config.js';
import { NativeLabelSync } from './native-label-sync.js';
import { assertReleaseJobResults } from './release-run.js';

export const nativeCommands = new Set(['release-admission', 'managed-sync', 'release-plan', 'release-pipeline', 'dependency-updates']);
const allowed: Record<string, string[]> = {
  'dependency-updates targets': ['repository', 'output'],
  'dependency-updates preflight': ['repository-id', 'policy-sha', 'output'],
  'release-pipeline gates': ['mode', 'results', 'output'],
  'release-pipeline identity': ['unit', 'tag', 'release-id', 'release-pr', 'policy-sha', 'source-dir', 'policy-dir', 'output'],
  'release-pipeline recover': ['record', 'directory', 'policy-dir', 'home', 'output'],
  'release-pipeline build': ['record', 'build-id', 'source-dir', 'output-dir', 'home', 'output'],
  'release-pipeline collect': ['record', 'raw-dir', 'output-dir', 'policy-dir', 'home', 'output'],
  'release-pipeline inspect': ['record', 'selection', 'directory', 'policy-dir', 'source-dir', 'home', 'staging', 'sbom-home', 'output'],
  'release-pipeline download': ['record', 'artifact-id', 'digest', 'phase', 'directory', 'policy-dir', 'home', 'output'],
  'release-pipeline seal': ['directory', 'manifest', 'output'],
  'release-pipeline publish': ['record', 'directory', 'output'],
  'release-pipeline verify': ['record', 'directory', 'output'],
  'release-admission validate': ['repository', 'source-sha', 'policy-sha', 'descriptor', 'central-config', 'offline', 'output'],
  'release-admission prepare': ['repository', 'source-sha', 'policy-sha', 'source-dir', 'policy-dir', 'central-config', 'unit', 'output-dir'],
  'managed-sync preview': ['repository-id', 'mode', 'policy-dir', 'target-dir', 'input-manifest', 'output-dir', 'central-config', 'organization-dir'],
  'managed-sync targets': ['repository', 'output'],
  'managed-sync preflight': ['repository-id', 'policy-sha', 'expected-base-sha', 'output'],
  'managed-sync apply': ['repository-id', 'policy-sha', 'preview-dir', 'target-dir', 'output'],
  'managed-sync labels': ['repository-id', 'policy-sha', 'policy-dir', 'mode', 'output'],
  'release-plan targets': ['repository', 'output'],
  'release-plan inspect': ['repository-id', 'policy-sha', 'phase', 'output'],
  'release-plan dispatch': ['repository-id', 'unit', 'release-id', 'release-pr', 'policy-sha'],
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
  const optional = command.endsWith(' targets') ? ['repository'] : command === 'managed-sync preflight' ? ['expected-base-sha']
    : command === 'managed-sync preview' ? ['input-manifest', 'central-config', 'organization-dir'] : [];
  for (const field of fields) if (!optional.includes(field) && !args[field]) throw new Error(`NATIVE_CLI: missing ${field}`);
  return { command, args };
}
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
export async function nativeReleaseCli(argv: readonly string[]) {
  const { command, args } = parseNativeInvocation(argv), required = (name: string) => args[name]!;
  if (command === 'dependency-updates preflight') {
    if (!/^[1-9][0-9]*$/.test(required('repository-id'))) throw new Error('NATIVE_CLI: repository ID');
    const result = await new NativeControlPlane().dependencyPreflight(Number(required('repository-id')), required('policy-sha'));
    await writeFile(required('output'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `enabled=${result.mode === 'enabled'}\n`);
    return;
  }
  if (command === 'managed-sync labels') {
    if (!['preview', 'apply'].includes(required('mode')) || !/^[1-9][0-9]*$/.test(required('repository-id'))) throw new Error('NATIVE_CLI: label mode or repository');
    const result = await new NativeLabelSync().run(Number(required('repository-id')), required('policy-sha'), resolve(required('policy-dir')), required('mode') === 'apply');
    await writeFile(required('output'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
    return;
  }
  if (command.startsWith('release-pipeline ')) {
    let result: unknown;
    if (command === 'release-pipeline gates') {
      const mode = required('mode'); if (!['build', 'verify'].includes(mode)) throw new Error('NATIVE_CLI: invalid release mode');
      const needs = JSON.parse(required('results'));
      assertReleaseJobResults(mode as 'build' | 'verify', 'none', Object.fromEntries(Object.entries(needs).map(([name, value]) => [name, (value as { result: string }).result])));
      result = { mode, verifiedJobResults: true };
    } else if (command === 'release-pipeline identity') {
      result = await pipelineIdentity({ unit: required('unit'), tag: required('tag'), releaseId: Number(required('release-id')), releasePr: Number(required('release-pr')),
        policySha: required('policy-sha'), sourceDirectory: resolve(required('source-dir')), policyDirectory: resolve(required('policy-dir')) });
      const record = result as PipelineRecord;
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `record=${JSON.stringify(record)}\nmode=${record.mode}\npolicy_sha=${record.policySha}\nsource_sha=${record.sourceSha}\nmatrix=${JSON.stringify({ include: record.admitted.unit.builds.map(build => ({ id: build.id, runner: 'windows-2025' })) })}\n`);
    } else if (command === 'release-pipeline seal') result = await pipelineSeal(required('directory'), await json(required('manifest')));
    else {
      const record = parsePipelineRecord(await json(required('record')), process.env);
      if (command === 'release-pipeline recover') {
        const recovered = await pipelineRecoverFinal(record, resolve(required('directory')), resolve(required('policy-dir')), resolve(required('home')));
        result = recovered;
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `found=${recovered.found}\n${recovered.found ? `artifact_id=${recovered.artifactId}\ndigest=${recovered.digest.slice(7)}\n` : ''}`);
      } else if (command === 'release-pipeline build') {
        result = await pipelineBuild(record, required('build-id'), required('source-dir'), required('output-dir'), required('home'));
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `artifact_name=${(result as { artifactName: string }).artifactName}\n`);
      } else if (command === 'release-pipeline collect') {
        result = await pipelineProducers(record);
        await pipelineDownloadProducers(record, result as Awaited<ReturnType<typeof pipelineProducers>>, required('raw-dir'), required('policy-dir'), required('home'));
        await pipelineCollect(record, result as Awaited<ReturnType<typeof pipelineProducers>>, required('raw-dir'), required('output-dir'));
      } else if (command === 'release-pipeline inspect') {
        result = await pipelineInspect(record, await json(required('selection')), required('directory'), required('policy-dir'), required('home'));
        await generateReleaseSbom(record, resolve(required('directory')), resolve(required('source-dir')), resolve(required('policy-dir')), resolve(required('staging')), resolve(required('sbom-home')));
        await writeFile(join(required('directory'), 'release-notes.md'), await pipelineNotes(record, required('source-dir'), required('policy-dir')), { flag: 'wx' });
      } else if (command === 'release-pipeline download') {
        result = await pipelineDownloadPhase(record, Number(required('artifact-id')), required('digest'), required('phase') as 'collected' | 'final', resolve(required('directory')), resolve(required('policy-dir')), resolve(required('home')));
      } else if (command === 'release-pipeline publish') result = await pipelinePublish(record, required('directory'));
      else result = await pipelineVerifyPublished(record, required('directory'));
    }
    await writeFile(required('output'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return;
  }
  if (command.endsWith(' targets')) {
    const targets = await new NativeControlPlane().targets(command.startsWith('release-plan ') ? 'release' : command.startsWith('dependency-updates ') ? 'dependencyUpdates' : 'managedSync', args.repository);
    await writeFile(required('output'), JSON.stringify(targets, null, 2) + '\n', { flag: 'wx' });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: targets.include })}\nhas_targets=${targets.include.length > 0}\n`);
    return;
  }
  if (command.startsWith('release-plan ')) {
    for (const key of ['repository-id', ...(command.endsWith('dispatch') ? ['release-id', 'release-pr'] : [])]) {
      if (!/^[1-9][0-9]*$/.test(required(key)) || !Number.isSafeInteger(Number(required(key)))) throw new Error(`NATIVE_CLI: invalid ${key}`);
    }
    const planner = new NativeReleasePlanner();
    if (command.endsWith('dispatch')) {
      const result = await planner.dispatch(Number(required('repository-id')), required('unit'), Number(required('release-id')), Number(required('release-pr')), required('policy-sha'));
      process.stdout.write(JSON.stringify(result) + '\n'); return;
    }
    const result = await planner.inspect(Number(required('repository-id')), required('policy-sha'), required('phase') as 'before' | 'after');
    await writeFile(required('output'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
      `should_run_release=${result.should_run_release}\nshould_run_pr=${result.should_run_pr}\nneeds_write=${result.should_run_release || result.should_run_pr || result.units.some(unit => unit.releaseId !== null)}\nunits=${JSON.stringify(result.units)}\n`);
    return;
  }
  if (command === 'managed-sync preflight') {
    if (!/^[1-9][0-9]*$/.test(required('repository-id'))) throw new Error('NATIVE_CLI: repository ID');
    const result = await new NativeControlPlane().syncPreflight(Number(required('repository-id')), required('policy-sha'), args['expected-base-sha']);
    await writeFile(required('output'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `enabled=${result.mode === 'enabled'}\nbase_sha=${result.mode === 'enabled' ? result.expectedBaseSha : ''}\nobservation_sha=${result.observationSha}\n`);
    return;
  }
  if (command === 'managed-sync apply') {
    const files = await applyManagedPreview(required('preview-dir'), required('target-dir'), Number(required('repository-id')), required('policy-sha'));
    await writeFile(required('output'), JSON.stringify({ files, remoteWrites: 0 }, null, 2) + '\n', { flag: 'wx' });
    if (process.env.GITHUB_OUTPUT) {
      const delimiter = 'managed_paths_' + (await import('node:crypto')).randomBytes(16).toString('hex');
      await appendFile(process.env.GITHUB_OUTPUT, `changed=${files.length > 0}\nadd_paths<<${delimiter}\n${files.join('\n')}\n${delimiter}\n`);
    }
    return;
  }
  if (command.startsWith('release-admission ')) {
    const configPath = resolve(required('central-config')), config = parseRepositoryCatalog(await json(configPath));
    const repository = Object.values(config.repositories).find(repository => repository.fullName === required('repository'));
    if (!repository) throw new Error('NATIVE_CLI: repository not registered');
    const sourceDirectory = command.endsWith('validate') ? dirname(dirname(resolve(required('descriptor')))) : resolve(required('source-dir'));
    const policyDirectory = command.endsWith('validate') ? dirname(dirname(configPath)) : resolve(required('policy-dir'));
    if (command.endsWith('validate') && resolve(required('descriptor')) !== join(sourceDirectory, '.github/steward-release.json')) throw new Error('NATIVE_CLI: descriptor path');
    const input: AdmissionInput = { repository: repository.fullName, repositoryId: repository.repositoryId,
      sourceSha: required('source-sha'), policySha: required('policy-sha'), sourceDirectory, policyDirectory, centralConfig: config };
    const units = await validateReleaseSource(input);
    if (command.endsWith('validate')) {
      const descriptor = await localGitSnapshot.file(sourceDirectory, input.sourceSha, '.github/steward-release.json');
      if (!descriptor?.equals(await readFile(required('descriptor')))) throw new Error('NATIVE_CLI: working descriptor differs from source');
      await writeFile(required('output'), JSON.stringify({ repositoryId: repository.repositoryId, sourceSha: input.sourceSha, policySha: input.policySha, units, remoteWrites: 0 }, null, 2) + '\n', { flag: 'wx' });
      return;
    }
    const admitted = units.find(unit => unit.unit.id === required('unit')); if (!admitted) throw new Error('NATIVE_CLI: unit not registered');
    const out = resolve(required('output-dir'));
    for (const directory of [sourceDirectory, policyDirectory]) {
      const rel = relative(directory, out);
      if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) throw new Error('NATIVE_CLI: output inside source');
    }
    // mkdir is exclusive; prepare never overwrites an old run's directory.
    await mkdir(out, { recursive: false });
    const paths = ['.github/steward-release.json', '.github/release-template.md.mustache', 'release-please-config.json', '.release-please-manifest.json',
      admitted.unit.versionFile, admitted.unit.changelogPath, admitted.unit.notesPath, ...admitted.unit.builds.map(build => build.entrypoint)];
    for (const path of new Set(paths)) {
      const bytes = await localGitSnapshot.file(sourceDirectory, input.sourceSha, path); if (!bytes) throw new Error('NATIVE_CLI: source disappeared');
      const target = join(out, 'inputs', path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx', mode: 0o444 });
    }
    await writeFile(join(out, 'admission.json'), JSON.stringify({ repositoryId: input.repositoryId, sourceSha: input.sourceSha, policySha: input.policySha,
      ...admitted, remoteWrites: 0, builds: admitted.unit.builds.map(build => ({ ...build, command: 'pwsh', argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', build.entrypoint, ...build.args] })) }, null, 2) + '\n', { flag: 'wx' });
    return;
  }
  const policyDirectory = resolve(required('policy-dir')), targetDirectory = resolve(required('target-dir'));
  const catalog = parseRepositoryCatalog(await json(args['central-config'] ?? join(policyDirectory, 'config/repositories.json')));
  const repository = catalog.repositories[required('repository-id')];
  if (!repository?.managed) throw new Error('NATIVE_CLI: repository not managed');
  const policySha = repository.automation.managedSync.policySha;
  if (!policySha) throw new Error('NATIVE_CLI: no adopted synchronization policy');
  if (await localGitSnapshot.head(policyDirectory) !== policySha) throw new Error('NATIVE_CLI: policy checkout mismatch');
  const listBytes = await localGitSnapshot.file(policyDirectory, policySha, 'config/managed-files.json');
  if (!listBytes) throw new Error('NATIVE_CLI: missing managed file list');
  const list = parseManagedFileConfig(JSON.parse(listBytes.toString('utf8')), Object.keys(catalog.repositories));
  if (list.schemaVersion !== 1 || !Array.isArray(list.repositories?.[required('repository-id')])) throw new Error('NATIVE_CLI: managed file list');
  const rules: SourceRule[] = list.repositories[required('repository-id')]!.map(rule => ({ ...rule, sourceSha: rule.sourceRepository === 'splrad/steward' ? policySha : rule.sourceSha! }));
  let onboarding: { directory: string; manifest: OnboardingManifest } | undefined;
  if (required('mode') === 'onboard') {
    const manifestPath = resolve(required('input-manifest') ?? '');
    if (manifestPath !== join(policyDirectory, 'config/onboarding', String(repository.repositoryId), 'manifest.json')) throw new Error('NATIVE_CLI: onboarding path');
    const manifest = await json(manifestPath); validateOnboardingManifest(manifest); onboarding = { directory: dirname(manifestPath), manifest };
  } else if (args['input-manifest']) throw new Error('NATIVE_CLI: sync cannot use onboarding payload');
  await previewManagedSync({ repositoryId: repository.repositoryId, fullName: repository.fullName, defaultBranch: repository.defaultBranch,
    expectedBaseSha: onboarding?.manifest.expectedBaseSha ?? await localGitSnapshot.head(targetDirectory), policySha,
    configuredPolicySha: policySha, revokedPolicyShas: repository.revokedPolicyShas, mode: required('mode') as 'sync' | 'onboard',
    targetDirectory, sourceDirectories: { 'splrad/steward': policyDirectory, ...(args['organization-dir'] ? { 'splrad/.github': resolve(args['organization-dir']) } : {}) }, rules, ...(onboarding ? { onboarding } : {}), outputDirectory: required('output-dir') });
}
