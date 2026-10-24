import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { Version } from 'release-please/build/src/version.js';
import { TagName } from 'release-please/build/src/util/tag-name.js';
import { parseReleaseDescriptor, assertAdmittedAdapter, artifactNames, type ReleaseUnit } from '../../core/src/release-descriptor.js';
import { parseRepositoryCatalog, releaseWriteAuthority } from '../../core/src/repository-policy.js';
import { parseSupplementalNotes } from '../../core/src/release-template.js';
import { localGitSnapshot, type GitSnapshot } from './managed-sync-preview.js';

function fail(reason: string): never { throw new Error(`RELEASE_ADMISSION: ${reason}`); }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface AdmissionInput {
  repository: string; repositoryId: number; sourceSha: string; policySha: string; sourceDirectory: string; policyDirectory: string; centralConfig: unknown;
}
export interface AdmittedUnit { unit: ReleaseUnit; version: string; packageVersion: string; tag: string; assets: { id: string; name: string }[]; descriptorSha256: string; templateSha256: string }
export async function validateReleaseSource(input: AdmissionInput, snapshot: GitSnapshot = localGitSnapshot): Promise<AdmittedUnit[]> {
  if (![input.sourceSha, input.policySha].every(sha => /^[a-f0-9]{40}$/.test(sha))) fail('invalid source or policy SHA');
  const catalog = parseRepositoryCatalog(input.centralConfig), policy = catalog.repositories[String(input.repositoryId)];
  if (!policy || policy.fullName !== input.repository || !policy.managed) fail('repository identity');
  const file = async (directory: string, sha: string, path: string) => {
    const bytes = await snapshot.file(directory, sha, path);
    if (!bytes || bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) fail(`missing or non-text committed input: ${path}`);
    return bytes;
  };
  const source = (path: string) => file(input.sourceDirectory, input.sourceSha, path);
  const descriptorBytes = await source('.github/steward-release.json');
  const descriptor = parseReleaseDescriptor(JSON.parse(descriptorBytes.toString('utf8')));
  if (JSON.stringify(descriptor.units.map(unit => unit.id).sort()) !== JSON.stringify(Object.keys(policy.release.units).sort())) fail('central unit mapping');
  const template = await source('.github/release-template.md.mustache');
  const trustedTemplate = await file(input.policyDirectory, input.policySha, 'config/templates/release.md.mustache');
  if (!template.equals(trustedTemplate)) fail('unadopted release template');
  const adoptedSchema = await source('schema/steward-release.schema.json');
  if (!adoptedSchema.equals(await file(input.policyDirectory, input.policySha, 'schema/steward-release.schema.json'))) fail('unadopted descriptor schema');
  const manifest = JSON.parse((await source('.release-please-manifest.json')).toString('utf8'));
  const rp = JSON.parse((await source('release-please-config.json')).toString('utf8'));
  if (Object.keys(manifest).sort().join(',') !== descriptor.units.map(unit => unit.releasePleasePath).sort().join(',')
    || !rp.packages || Object.keys(rp.packages).sort().join(',') !== Object.keys(manifest).sort().join(',')) fail('Release Please unit mapping');
  const result: AdmittedUnit[] = [];
  for (const unit of descriptor.units) {
    // Only adapters with actual format/build coverage are admitted. Other ecosystems remain fixture-only until their contract passes.
    assertAdmittedAdapter(unit, ['native']);
    if (unit.signingPolicy !== 'none') fail('signing adapter not admitted');
    const versionBytes = await source(unit.versionFile), version = versionBytes.toString('utf8').trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version) || versionBytes.toString('utf8') !== version + '\n'
      || manifest[unit.releasePleasePath] !== version) fail('native version/manifest mismatch');
    const packageConfig = rp.packages[unit.releasePleasePath];
    if (packageConfig['release-type'] !== 'simple' || packageConfig['version-file'] !== unit.versionFile
      || (packageConfig['changelog-path'] ?? 'CHANGELOG.md') !== unit.changelogPath || rp.draft !== true || rp['force-tag-creation'] !== true) fail('native Release Please configuration');
    const changelog = (await source(unit.changelogPath)).toString('utf8');
    const headings = changelog.split(/\r?\n/).filter(line => /^##?\s/.test(line));
    if (headings.filter(line => new RegExp(`^##?\\s+(?:\\[)?${version.replaceAll('.', '\\.')}[\\]\\s(]`).test(line)).length !== 1) fail('missing or duplicate version changelog');
    parseSupplementalNotes((await source(unit.notesPath)).toString('utf8'));
    for (const build of unit.builds) {
      await source(build.entrypoint);
      if (build.os !== 'windows' || build.arch !== 'x64' || !build.entrypoint.endsWith('.ps1')) fail('native build adapter not admitted');
      if (build.args.length) fail('native adapter arguments not admitted');
    }
    const central = policy.release.units[unit.id]!;
    if (JSON.stringify(unit.channels.map(channel => channel.id).sort()) !== JSON.stringify(Object.keys(central.channels).sort())
      || unit.channels.some(channel => channel.kind !== central.channels[channel.id]!.kind)) fail('channel mapping');
    const names = artifactNames(unit, version);
    const includeComponent = packageConfig['include-component-in-tag'] ?? rp['include-component-in-tag'] ?? true;
    const component = includeComponent ? packageConfig.component : undefined;
    if (includeComponent && component !== unit.id) fail('explicit native tag component');
    const tag = new TagName(Version.parse(version), component, packageConfig['tag-separator'] ?? rp['tag-separator'] ?? '-',
      packageConfig['include-v-in-tag'] ?? rp['include-v-in-tag'] ?? true).toString();
    result.push({ unit, version, packageVersion: version, tag, assets: [...names].map(([id, name]) => ({ id, name })), descriptorSha256: digest(descriptorBytes), templateSha256: digest(template) });
  }
  return result;
}
export interface ReleaseIdentityObservation {
  complete: boolean; repository: { id: number; fullName: string; defaultBranch: string };
  githubSha: string; githubRef: string; resolvedTagSha: string; policyOnProtectedMain: boolean; adoptionAncestor: boolean;
  release: { id: number; tag: string; draft: boolean };
  pull: { number: number; merged: boolean; mergeSha: string; baseRef: string; baseRepositoryId: number };
  caller: string;
}
export function admitReleaseIdentity(input: AdmissionInput, unit: AdmittedUnit, requested: { releaseId: number; releasePr: number }, evidence: ReleaseIdentityObservation): 'build' | 'verify' {
  const catalog = parseRepositoryCatalog(input.centralConfig), policy = catalog.repositories[String(input.repositoryId)];
  if (!policy || policy.fullName !== input.repository || !evidence.complete || evidence.repository.id !== input.repositoryId
    || evidence.repository.fullName !== input.repository || evidence.repository.defaultBranch !== policy.defaultBranch
    || evidence.githubSha !== input.sourceSha || evidence.githubRef !== `refs/tags/${unit.tag}` || evidence.resolvedTagSha !== input.sourceSha
    || !evidence.policyOnProtectedMain || !evidence.adoptionAncestor || evidence.release.id !== requested.releaseId
    || !Number.isSafeInteger(requested.releaseId) || requested.releaseId < 1 || !Number.isSafeInteger(requested.releasePr) || requested.releasePr < 1
    || evidence.release.tag !== unit.tag || evidence.pull.number !== requested.releasePr || !evidence.pull.merged
    || evidence.pull.mergeSha !== input.sourceSha || evidence.pull.baseRef !== policy.defaultBranch || evidence.pull.baseRepositoryId !== input.repositoryId) fail('release source identity');
  const document = parseDocument(evidence.caller, { uniqueKeys: true });
  if (document.errors.length) fail('caller YAML');
  const caller = document.toJS();
  if (caller.on?.workflow_dispatch === undefined || Object.keys(caller.on).join(',') !== 'workflow_dispatch'
    || caller.jobs?.publish?.uses !== `splrad/steward/.github/workflows/product-release.yml@${input.policySha}`) fail('caller policy binding');
  const fields = ['unit', 'tag', 'release_id', 'release_pr'];
  const inputs = caller.on.workflow_dispatch?.inputs, mapping = caller.jobs.publish.with;
  if (Object.keys(caller.jobs).join(',') !== 'publish' || Object.keys(caller.jobs.publish).sort().join(',') !== 'uses,with'
    || !inputs || Object.keys(inputs).sort().join(',') !== [...fields].sort().join(',')
    || !mapping || Object.keys(mapping).sort().join(',') !== [...fields].sort().join(',')
    || fields.some(name => inputs[name]?.required !== true || inputs[name]?.type !== 'string' || Object.keys(inputs[name]).some(key => !['required', 'type', 'description'].includes(key))
      || mapping[name] !== '${{ inputs.' + name + ' }}')
    || caller['run-name'] !== 'Publish ${{ inputs.unit }} / ${{ inputs.tag }} / ${{ inputs.release_id }}') fail('caller input contract');
  const permissions = caller.permissions;
  const expected = { contents: 'write', actions: 'read', 'id-token': 'write', attestations: 'write' };
  if (!permissions || Object.keys(permissions).sort().join(',') !== Object.keys(expected).sort().join(',')
    || Object.entries(expected).some(([name, value]) => permissions[name] !== value) || caller.jobs.publish.secrets !== undefined) fail('caller permissions');
  if (evidence.release.draft) { releaseWriteAuthority(catalog, input.repositoryId, input.repository, unit.unit.id, input.policySha); return 'build'; }
  return 'verify';
}
