import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import { GitHub } from 'release-please/build/src/github.js';
import { FileNotFoundError } from 'release-please/build/src/errors/index.js';
import { setLogger } from 'release-please/build/src/util/logger.js';
import { generateCandidate, readOnlyReleasePlease, type CandidateGenerationFacts } from '../src/release-candidate-update.js';
import type { Scm } from 'release-please/build/src/scm.js';

const B = 'a'.repeat(40), C = 'c'.repeat(40);
setLogger({ debug() {}, info() {}, warn() {}, error() {}, trace() {} });
function fixture(multi = false) {
  const packages = multi ? { app: { 'release-type': 'simple', component: 'app' }, lib: { 'release-type': 'simple', component: 'lib' } } : { '.': { 'release-type': 'simple', 'include-component-in-tag': false } };
  const units = Object.keys(packages).map(path => ({ id: path === '.' ? 'app' : path, path }));
  const config = JSON.stringify({ 'separate-pull-requests': false, packages }), manifest = JSON.stringify(Object.fromEntries(units.map(u => [u.path, '1.0.0'])));
  const files = new Map<string, string>([['release-please-config.json', config], ['.release-please-manifest.json', manifest], ...units.map(u => [u.path === '.' ? 'version.txt' : u.path + '/version.txt', '1.0.0\n'] as [string, string])]);
  const calls: { type: string; branch?: string; options?: unknown }[] = [], commits = [{ sha: B, message: 'feat: new feature', files: units.map(u => u.path === '.' ? 'code.ts' : u.path + '/code.ts') }, { sha: C, message: 'chore: release', files: [] }];
  const client = Object.assign(Object.create(GitHub.prototype), {
    repository: { owner: 'fixture', repo: 'product', defaultBranch: 'stable' }, logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
    getFileJson: async (path: string, branch: string) => { calls.push({ type: 'json', branch }); return JSON.parse(files.get(path)!); },
    getFileContentsOnBranch: async (path: string, branch: string) => {
      calls.push({ type: 'file', branch }); const content = files.get(path); if (content === undefined) throw new FileNotFoundError(path);
      return { content: Buffer.from(content).toString('base64'), parsedContent: content, sha: 'b'.repeat(40), mode: '100755' };
    },
    mergeCommitIterator: async function* (branch: string, options: unknown) { calls.push({ type: 'commits', branch, options }); yield* commits; },
    releaseIterator: async function* (options: unknown) { calls.push({ type: 'releases', options }); for (const u of units) yield { id: units.indexOf(u) + 1, tagName: u.path === '.' ? 'v1.0.0' : u.id + '-v1.0.0', sha: C, url: 'https://github.com/fixture/product/releases/1', notes: '' }; },
    tagIterator: async function* () {}, pullRequestIterator: async function* () {},
  }) as Scm;
  const facts: CandidateGenerationFacts = { baseSha: B, defaultBranch: 'stable', config, manifest, commitCount: 1800,
    releases: units.map((u, i) => ({ id: i + 1, tag: u.path === '.' ? 'v1.0.0' : u.id + '-v1.0.0', sha: C, bodyDigest: 'd'.repeat(64), draft: false })),
    tags: [], boundaries: units.map(u => ({ path: u.path, kind: 'tag', sha: C, reference: u.id + '-v1.0.0', found: true })), releaseInventoryComplete: true, protectionsEvidencePath: 'generated/protection.json' };
  return { client, facts, files, calls, commits, units, options: { configPath: 'release-please-config.json', manifestPath: '.release-please-manifest.json', units, readFacts: async () => structuredClone(facts), createReadClient: async () => client } };
}
function firstLayerScape() {
  const f=fixture();Object.assign(f.client.repository,{owner:'splrad',repo:'LayerScape'});
  f.units[0]!.id='layerscape';f.facts.manifest='{}';f.facts.releases=[];f.facts.tags=[];
  f.facts.boundaries=[{path:'.',kind:'full-tree',sha:null,reference:null,found:true}];
  f.facts.config=JSON.stringify({'separate-pull-requests':false,'include-component-in-tag':false,packages:{'.':{'release-type':'simple','version-file':'VERSION','initial-version':'1.0.0'}}});
  f.files.set('release-please-config.json',f.facts.config);f.files.set('.release-please-manifest.json','{}');f.files.set('VERSION','9.2.2\n');
  f.client.releaseIterator=async function*(){};
  f.commits.push(...Array.from({length:705},(_,i)=>({sha:(i+1).toString(16).padStart(40,'0'),message:'chore: earlier source',files:['README.md']})));
  f.facts.commitCount=f.commits.length;return f;
}
it('v1.54 generates native 1.0.0 from empty manifest, VERSION 9.2.2 and all reachable history',async()=>{
  const f=firstLayerScape(),result=await generateCandidate(B,f.options);
  expect(result.status).toBe('READY');if(result.status!=='READY')throw Error('expected candidate');
  expect(result.snapshot.units).toEqual([{id:'layerscape',path:'.',version:'1.0.0',tag:'v1.0.0'}]);
  expect(result.snapshot.files.find(file=>file.path==='VERSION')?.content?.trim()).toBe('1.0.0');
  expect(f.files.get('VERSION')).toBe('9.2.2\n');
});
it.each(['2.5.0','9.2.2','1.0.1'])('v1.54 rejects first-release Release-As %s before returning a writable snapshot',async version=>{
  const f=firstLayerScape();f.commits[0]!.message='fix: first series\n\nRelease-As: '+version;
  await expect(generateCandidate(B,f.options)).rejects.toThrow('CANDIDATE_FIRST_RELEASE_VERSION');
  expect(f.files.get('VERSION')).toBe('9.2.2\n');
});
it('uses native RP first-release calculation without a second per-commit coverage proof',async()=>{
  const f=firstLayerScape();f.commits.pop();await expect(generateCandidate(B,f.options)).resolves.toMatchObject({status:'READY'});
});
it.each(['manifest','manifest-current','extra-manifest','root-bootstrap','package-draft','package-force','wrong-target','existing-release','existing-tag'])('v1.54 rejects first-release residue: %s',async kind=>{
  const f=firstLayerScape(),config=JSON.parse(f.facts.config);
  if(kind==='manifest')f.facts.manifest=JSON.stringify({'.':'9.2.2'});
  if(kind==='manifest-current')f.facts.manifest=JSON.stringify({'.':'1.0.0'});
  if(kind==='extra-manifest')f.facts.manifest=JSON.stringify({other:'9.2.2'});
  if(kind==='root-bootstrap')config['bootstrap-sha']=C;
  if(kind==='package-draft')config.packages['.'].draft=true;
  if(kind==='package-force')config.packages['.']['force-tag-creation']=true;
  if(kind==='wrong-target')config.packages['.']['initial-version']='9.2.3';
  if(kind==='existing-release')f.facts.releases=[{id:1,tag:'v1.0.0',sha:C,bodyDigest:'d'.repeat(64),draft:false}];
  if(kind==='existing-tag')f.facts.tags=[{tag:'v1.0.0',sha:C}];
  f.facts.config=JSON.stringify(config);f.files.set('release-please-config.json',f.facts.config);f.files.set('.release-please-manifest.json',f.facts.manifest);
  await expect(generateCandidate(B,f.options)).rejects.toThrow('CANDIDATE_FIRST_RELEASE_INPUT');
  expect(f.files.get('VERSION')).toBe('9.2.2\n');
});
it('continues LayerScape from its recorded release boundary after the first release',async()=>{
  const f=fixture();Object.assign(f.client.repository,{owner:'splrad',repo:'LayerScape'});
  f.units[0]!.id='layerscape';
  const result=await generateCandidate(B,f.options);
  expect(result.status).toBe('READY');
  if(result.status!=='READY')throw Error('expected candidate');
  expect(result.snapshot.units).toEqual([{id:'layerscape',path:'.',version:'1.1.0',tag:'v1.1.0'}]);
});
it.each([false, true])('uses actual upstream generation and manifest versions for multi=%s', async multi => {
  const f = fixture(multi), result = await generateCandidate(B, f.options);
  expect(result.status).toBe('READY'); if (result.status !== 'READY') return;
  expect(result.snapshot.units.map(u => u.version)).toEqual(f.units.map(() => '1.1.0'));
  expect(result.snapshot.units.map(u => u.tag)).toEqual(multi ? ['app-v1.1.0', 'lib-v1.1.0'] : ['v1.1.0']);
  expect(f.calls.filter(c => c.type === 'commits')).toEqual([{ type: 'commits', branch: 'stable', options: { maxResults: 1801, backfillFiles: true, batchSize: 10 } }]);
  expect(f.calls.filter(c => c.type === 'json').every(c => c.branch === 'stable')).toBe(true);
  expect(result.snapshot.files.find(f => f.path.endsWith('version.txt'))?.mode).toBe('100755');
});
it.each([false, true])('keeps the adopted RP header/footer natively parseable for multi=%s', async multi => {
  const f = fixture(multi), defaults = JSON.parse(readFileSync('config/release/defaults.json', 'utf8'));
  const config = { ...JSON.parse(f.facts.config), ...Object.fromEntries(['separate-pull-requests', 'pull-request-header', 'pull-request-footer'].map(key => [key, defaults[key]])) };
  f.facts.config = JSON.stringify(config); f.files.set('release-please-config.json', f.facts.config);
  const result = await generateCandidate(B, f.options);
  expect(result.status).toBe('READY'); if (result.status !== 'READY') throw new Error('fixture candidate');
  expect(result.body).toContain(defaults['pull-request-header']); expect(result.body).toContain(defaults['pull-request-footer']);
  expect(PullRequestBody.parse(result.body)?.releaseData).toHaveLength(multi ? 2 : 1);
  expect(result.snapshot.units).toHaveLength(multi ? 2 : 1);
});
it('upstream Release-As remains the version authority and mutable fact drift discards the candidate', async () => {
  const f = fixture(); f.commits[0]!.message = 'fix: adjust behavior\n\nRelease-As: 2.5.0';
  const result = await generateCandidate(B, f.options); expect(result.status === 'READY' && result.snapshot.units[0]!.version).toBe('2.5.0');
  let count = 0; f.options.readFacts = async () => ({ ...f.facts, baseSha: count++ ? 'e'.repeat(40) : B });
  expect(await generateCandidate(B, f.options)).toEqual({ status: 'DRIFT' });
});
it('preserves upstream CompositeUpdater, missing-file creation and mode semantics', async () => {
  const f = fixture(), path = 'shared.txt'; f.files.set(path, 'original');
  const update = (path: string, createIfMissing: boolean, suffix: string) => ({ path, createIfMissing, updater: { updateContent: (old?: string) => (old ?? '') + suffix } });
  const changed = await f.client.buildChangeSet([update(path, false, '-A'), update(path, false, '-B'), update('missing.txt', false, 'skip'), update('new.txt', true, 'create')], B);
  expect(changed.get(path)).toMatchObject({ content: 'original-A-B', mode: '100755' }); expect(changed.has('missing.txt')).toBe(false); expect(changed.get('new.txt')?.content).toBe('create');
});
it('forbids lifecycle writes from the generator client', () => {
  const f = fixture(), client = readOnlyReleasePlease(f.client);
  expect(() => client.createRelease({} as never)).toThrow('RELEASE_PLEASE_WRITE_FORBIDDEN');
  expect(() => client.createPullRequest({} as never, 'stable', '', [])).toThrow('RELEASE_PLEASE_WRITE_FORBIDDEN');
  expect(() => client.updatePullRequest(1, {} as never, 'stable')).toThrow('RELEASE_PLEASE_WRITE_FORBIDDEN');
});
it('reaches the real release boundary beyond default commit search depths', async () => {
  const f = fixture();
  f.commits.splice(1, 0, ...Array.from({ length: 700 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, '0'), message: 'Documentation without a conventional title', files: ['README.md'] })));
  const result = await generateCandidate(B, f.options);
  expect(result.status).toBe('READY'); expect(result.status === 'READY' && result.snapshot.units[0]!.version).toBe('1.1.0');
});
it('uses native RP iterator semantics without a second all-commit coverage gate', async () => {
  const f = fixture(); f.commits.pop();
  await expect(generateCandidate(B, f.options)).resolves.toMatchObject({status:'READY'});
});
it('projects Go path tags and Python prereleases through their native upstream strategies', async () => {
  const f = fixture(true), config = JSON.stringify({ 'separate-pull-requests': false, packages: {
    app: { 'release-type': 'go', component: 'app', 'tag-separator': '/' },
    lib: { 'release-type': 'python', component: 'lib' },
  } });
  f.facts.config = config; f.files.set('release-please-config.json', config);
  f.files.set('lib/pyproject.toml', '[project]\nname = "lib"\nversion = "1.0.0"\n');
  f.client.findFilesByFilenameAndRef = async () => [];
  f.client.releaseIterator = async function* () {
    for (const [i, tagName] of ['app/v1.0.0', 'lib-v1.0.0'].entries()) yield { id: i + 1, tagName, sha: C, url: 'https://github.com/fixture/product/releases/1', notes: '' };
  };
  f.facts.releases[0]!.tag = 'app/v1.0.0'; f.facts.boundaries[0]!.reference = 'app/v1.0.0';
  f.commits[0]!.files = ['app/main.go']; f.commits.splice(1, 0, { sha: 'e'.repeat(40), message: 'feat: Python preview\n\nRelease-As: 2.0.0-rc.1', files: ['lib/main.py'] });
  const result = await generateCandidate(B, f.options); expect(result.status).toBe('READY'); if (result.status !== 'READY') return;
  expect(result.snapshot.units).toEqual([{ id: 'app', path: 'app', version: '1.1.0', tag: 'app/v1.1.0' },
    { id: 'lib', path: 'lib', version: '2.0.0-rc.1', tag: 'lib-v2.0.0-rc.1' }]);
  expect(result.snapshot.files.find(file => file.path === 'lib/pyproject.toml')?.content).toContain('2.0.0-rc.1');
});
it('keeps native workspace dependency propagation and all package projections', async () => {
  const f = fixture(true), config = JSON.stringify({ 'separate-pull-requests': false, plugins: ['node-workspace'], packages: {
    app: { 'release-type': 'node', component: 'app' }, lib: { 'release-type': 'node', component: 'lib' },
  } });
  f.facts.config = config; f.files.set('release-please-config.json', config);
  f.files.set('app/package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { lib: '^1.0.0' } }));
  f.files.set('lib/package.json', JSON.stringify({ name: 'lib', version: '1.0.0' }));
  f.commits[0]!.files = ['lib/api.ts'];
  const result = await generateCandidate(B, f.options); expect(result.status).toBe('READY'); if (result.status !== 'READY') return;
  expect(result.snapshot.units).toEqual([{ id: 'app', path: 'app', version: '1.0.1', tag: 'app-v1.0.1' },
    { id: 'lib', path: 'lib', version: '1.1.0', tag: 'lib-v1.1.0' }]);
  const app = JSON.parse(result.snapshot.files.find(file => file.path === 'app/package.json')!.content!);
  expect(app).toMatchObject({ version: '1.0.1', dependencies: { lib: '^1.1.0' } });
});


it.each(['tag', 'baseline', 'full-tree'] as const)('keeps an app baseline separate from a lib %s boundary', async kind => {
  const f = fixture(true), older = 'e'.repeat(40), oldFeature = 'f'.repeat(40);
  f.facts.manifest = JSON.stringify({app:'1.1.0',lib:kind==='full-tree'?'0.0.0':'1.0.0'});
  f.files.set('.release-please-manifest.json', f.facts.manifest); f.files.set('app/version.txt','1.1.0\n');
  f.facts.boundaries = [{path:'app',kind:'baseline',sha:C,reference:'app-cycle',found:true},
    {path:'lib',kind,sha:kind==='full-tree'?null:older,reference:kind==='full-tree'?null:'lib-v1.0.0',found:true}];
  f.commits.splice(0,f.commits.length,
    {sha:B,message:'fix: current app repair',files:['app/code.ts']},
    {sha:C,message:'chore: app version 1.1.0',files:[]},
    {sha:oldFeature,message:'feat: app already released\n\nfix: lib change',files:['app/code.ts','lib/code.ts']},
    {sha:older,message:'chore: old lib boundary',files:[]});
  f.client.releaseIterator=async function*(){if(kind==='tag')yield {id:2,tagName:'lib-v1.0.0',sha:older,url:'https://github.com/fixture/product/releases/2',notes:''};};
  f.facts.releases=kind==='tag'?[{id:2,tag:'lib-v1.0.0',sha:older,bodyDigest:'d'.repeat(64),draft:false}]:[];
  const result=await generateCandidate(B,f.options);
  expect(result.status).toBe('READY');if(result.status!=='READY')throw Error('candidate required');
  expect(result.snapshot.units.find(u=>u.id==='app')?.version).toBe('1.1.1');
  expect(result.snapshot.units.find(u=>u.id==='lib')?.version).toBe(kind==='full-tree'?'1.0.0':'1.1.0');
  expect(result.snapshot.files.find(file=>file.path==='app/CHANGELOG.md')?.content).not.toContain('already released');
});


it('applies baseline input before native workspace dependency propagation', async () => {
  const f=fixture(true),older='e'.repeat(40),oldFeature='f'.repeat(40);
  const config=JSON.stringify({'separate-pull-requests':false,plugins:['node-workspace'],packages:{app:{'release-type':'node',component:'app'},lib:{'release-type':'node',component:'lib'}}});
  f.facts.config=config;f.files.set('release-please-config.json',config);
  f.facts.manifest=JSON.stringify({app:'1.1.0',lib:'1.0.0'});f.files.set('.release-please-manifest.json',f.facts.manifest);
  f.files.set('app/package.json',JSON.stringify({name:'app',version:'1.1.0',dependencies:{lib:'^1.0.0'}}));
  f.files.set('lib/package.json',JSON.stringify({name:'lib',version:'1.0.0'}));
  f.facts.boundaries=[{path:'app',kind:'baseline',sha:C,reference:'app-cycle',found:true},{path:'lib',kind:'tag',sha:older,reference:'lib-v1.0.0',found:true}];
  f.commits.splice(0,f.commits.length,{sha:B,message:'feat: lib API',files:['lib/api.ts']},{sha:C,message:'chore: app release',files:[]},
    {sha:oldFeature,message:'feat: app already released',files:['app/api.ts']},{sha:older,message:'chore: lib release',files:[]});
  f.client.releaseIterator=async function*(){yield {id:2,tagName:'lib-v1.0.0',sha:older,url:'https://github.com/fixture/product/releases/2',notes:''};};
  const result=await generateCandidate(B,f.options);if(result.status!=='READY')throw Error('candidate required');
  expect(result.snapshot.units.map(u=>[u.id,u.version])).toEqual([['app','1.1.1'],['lib','1.1.0']]);
  expect(JSON.parse(result.snapshot.files.find(file=>file.path==='app/package.json')!.content!).dependencies.lib).toBe('^1.1.0');
});
