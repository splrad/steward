import { describe, expect, it } from 'vitest';
import { parseReleaseDescriptor, artifactNames, assertAdmittedAdapter, type ReleaseDescriptor } from '../src/release-descriptor.js';

const fixture = (): ReleaseDescriptor => ({ schemaVersion: 1, units: [{
  id: 'web-sdk', displayName: 'Web SDK', path: 'packages/web-sdk', releasePleasePath: 'packages/web-sdk', ecosystem: 'node',
  versionFile: 'packages/web-sdk/package.json', changelogPath: 'packages/web-sdk/CHANGELOG.md', notesPath: '.release-notes/web-sdk.md',
  builds: [{ id: 'node-any', os: 'ubuntu', arch: 'x64', entrypoint: 'scripts/build.mjs', args: [], expectedArtifacts: ['npm-tarball'] }],
  artifacts: [{ id: 'npm-tarball', file: 'web-sdk-${version}.tgz', kind: 'npm', mediaType: 'application/gzip', platform: 'any', architecture: 'any', build: 'node-any', required: true }],
  channels: [{ id: 'npm-public', kind: 'npm', artifacts: ['npm-tarball'], dependsOn: [] }],
}] });

it('parses independent Node/Python units and preserves native package versions', () => {
  const descriptor = fixture(), python = structuredClone(descriptor.units[0]!);
  Object.assign(python, { id: 'python-sdk', displayName: 'Python SDK', path: 'packages/python-sdk', releasePleasePath: 'packages/python-sdk',
    ecosystem: 'python', versionFile: 'packages/python-sdk/pyproject.toml', changelogPath: 'packages/python-sdk/CHANGELOG.md', notesPath: '.release-notes/python-sdk.md' });
  python.artifacts[0]!.file = 'python_sdk-${packageVersion}.tar.gz';
  python.artifacts[0]!.kind = 'python-sdist';
  python.channels = [{ id: 'pypi-public', kind: 'pypi', artifacts: ['npm-tarball'], dependsOn: ['web-sdk/npm-public'] }];
  descriptor.units.push(python);
  expect(parseReleaseDescriptor(descriptor)).toEqual(descriptor);
  expect(artifactNames(python, '1.2.3-rc.1', '1.2.3rc1').get('npm-tarball')).toBe('python_sdk-1.2.3rc1.tar.gz');
});

it('schema support does not enable an unvalidated adapter', () => {
  const unit = parseReleaseDescriptor(fixture()).units[0]!;
  expect(() => assertAdmittedAdapter(unit, [])).toThrow('not passed admission');
  expect(() => assertAdmittedAdapter(unit, ['node'])).not.toThrow();
});

describe('reject invalid contracts', () => {
  const mutations: [string, (d: any) => void][] = [
    ['missing key', d => { delete d.units[0].notesPath; }],
    ['unexpected key', d => { d.units[0].token = 'not-a-credential'; }],
    ['duplicate unit', d => { d.units.push(structuredClone(d.units[0])); }],
    ['absolute path', d => { d.units[0].versionFile = '/tmp/package.json'; }],
    ['traversal', d => { d.units[0].builds[0].entrypoint = '../build.mjs'; }],
    ['custom runner', d => { d.units[0].builds[0].os = 'self-hosted'; }],
    ['unlisted asset', d => { d.units[0].builds[0].expectedArtifacts = ['other']; }],
    ['unknown producer', d => { d.units[0].artifacts[0].build = 'other'; }],
    ['optional asset', d => { d.units[0].artifacts[0].required = false; }],
    ['asset glob', d => { d.units[0].artifacts[0].file = '*.tgz'; }],
    ['unknown variable', d => { d.units[0].artifacts[0].file = '${secret}.tgz'; }],
    ['reserved evidence', d => { d.units[0].artifacts[0].file = 'artifact-manifest.json'; }],
    ['unknown channel asset', d => { d.units[0].channels[0].artifacts = ['unknown']; }],
    ['unknown dependency', d => { d.units[0].channels[0].dependsOn = ['other/npm']; }],
    ['dependency cycle', d => { d.units[0].channels[0].dependsOn = ['web-sdk/npm-public']; }],
    ['version outside unit', d => { d.units[0].versionFile = 'other/package.json'; }],
    ['overlapping paths', d => {
      const other = structuredClone(d.units[0]);
      Object.assign(other, {id:'nested',path:'packages/web-sdk/nested',releasePleasePath:'packages/web-sdk/nested',versionFile:'packages/web-sdk/nested/package.json',changelogPath:'packages/web-sdk/nested/CHANGELOG.md',notesPath:'.release-notes/nested.md'});
      d.units.push(other);
    }],
  ];
  it.each(mutations)('%s', (_label, mutate) => {
    const descriptor = fixture(); mutate(descriptor);
    expect(() => parseReleaseDescriptor(descriptor)).toThrow('RELEASE_DESCRIPTOR');
  });
});
