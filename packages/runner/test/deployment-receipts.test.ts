import {expect, it, vi} from 'vitest';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const observer = () => import(pathToFileURL(resolve('scripts/deployment-receipts.mjs')).href);
const sha = 'a'.repeat(40);
const first = '11111111-1111-1111-1111-111111111111';
const second = '22222222-2222-2222-2222-222222222222';
const deployment = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

it('requires the protected controller and highest numeric version to agree', async () => {
  const {governance} = await observer();
  const tags = [9, 10].map(n => ({ref: 'refs/tags/controller-v' + n,
    object: {type: 'commit', sha: n === 10 ? sha : 'b'.repeat(40)}}));
  function reader(source: string) {
    return async (path: string) => path.includes('matching-refs') ? tags : {object: {type: 'commit', sha: source}};
  }
  expect((await governance(reader(sha))).rows[0]).toMatchObject({key: 'controller-v10', sha});
  await expect(governance(reader('c'.repeat(40)))).rejects.toThrow('do not yet agree');
});

it('uses explicit source metadata or corroborated legacy tags', async () => {
  const {versionSource} = await observer();
  const source = (tag: string, message: string) =>
    versionSource({annotations: {'workers/tag': tag, 'workers/message': message}});
  expect(source('', 'revert ' + sha)).toBeNull();
  expect(source('rel-aaaaaaaaaa-cfg1', 'Steward production release ' + sha)).toBe(sha);
  expect(source('rel-bbbbbbbbbb-cfg1', 'Steward production release ' + sha)).toBeNull();
  expect(source('git-' + sha, 'source-sha=' + 'b'.repeat(40))).toBeNull();
  expect(source('', 'source-sha=' + sha)).toBe(sha);
});

const loadProof = () => import(pathToFileURL(resolve('scripts/worker-module-proof.mjs')).href);
const mod = (name: string, type: string, text: string) =>
  ({name, content_type: type, content_base64: Buffer.from(text).toString('base64')});
const js = mod('index.js', 'application/javascript+module', 'entry');
const data = mod('nested/test.wasm', 'application/wasm', 'data');
const artifact = {main_module: 'index.js', modules: [js, data]};

it('matches all Wrangler upload modules including binary modules, MIME, names and entry point', async () => {
  const {builtDigest, servingDigest} = await loadProof();
  const form = new FormData();
  form.append('metadata', JSON.stringify({main_module: 'index.js'}));
  for (const m of [data, js]) {
    form.append(m.name, new Blob([Buffer.from(m.content_base64, 'base64')], {type: m.content_type}), m.name);
  }
  form.append('index.js.map', new Blob(['{}'], {type: 'application/source-map'}), 'index.js.map');
  const digest = await builtDigest(Buffer.from(await new Response(form).arrayBuffer()));
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(servingDigest(artifact)).toBe(digest);
  for (const other of [
    {modules: [js]}, {modules: [js, {...data, content_type: 'text/plain'}]},
    {modules: [js, {...data, name: 'other.wasm'}]}, {modules: [js, mod(data.name, data.content_type, 'changed')]},
    {main_module: data.name}, {modules: [js, js]}, {modules: [js, {...data, content_base64: 'invalid!'}]},
  ]) expect(servingDigest({...artifact, ...other})).not.toBe(digest);
});

const health = async () => ({status: 'ok', version: second});
const main = async () => ({status: 'ahead', merge_base_commit: {sha}});
function provider(path: string) {
  if (path.includes('deployments?')) return {deployments: [{id: deployment, versions:
    [{version_id: first, percentage: 75}, {version_id: second, percentage: 25}]}]};
  const id = path.split('/').at(-1)!.split('?')[0];
  return {id, ...artifact, annotations: id === first ? {'workers/tag': sha} : {}};
}

it('keeps split traffic visible independently of source proof and rejects stale observations', async () => {
  const {production} = await observer();
  const {servingDigest} = await loadProof();
  const digest = servingDigest(artifact);
  const read = (builds: object) => production(main, provider, health, [], builds);
  expect((await read({[sha]: digest})).rows).toMatchObject([
    {sha, facts: {version: first, percentage: 75, verification: 'verified', declared_sha: sha, on_main: true}},
    {sha: null, facts: {version: second, percentage: 25, verification: 'undeclared'}},
  ]);
  expect((await read({[sha]: 'b'.repeat(64)})).rows[0]).toMatchObject({sha: null, facts: {verification: 'mismatch'}});
  expect((await read({})).rows[0]).toMatchObject({sha: null, facts: {verification: 'unavailable'}});
  const withoutModules = async (path: string) => {
    if (path.includes('?include=modules')) throw Error('Unavailable');
    return provider(path);
  };
  expect((await production(main, withoutModules, health, [], {[sha]: digest})).rows[0])
    .toMatchObject({sha: null, facts: {percentage: 75, verification: 'unavailable'}});
  const missing = async () => {throw Object.assign(Error(), {status: 404});};
  expect((await production(missing, provider, health)).rows[0]).toMatchObject({sha: null, facts: {verification: 'off_main'}});
  await expect(production(main, provider, async () => ({status: 'ok', version: deployment}))).rejects.toThrow('disagree');
});

it('reuses only immutable version evidence written by the Actions bot, including after rollback', async () => {
  const {production} = await observer();
  const {servingDigest} = await loadProof();
  const record = {creator: 'MDM6Qm90NDE4OTgyODI=', sha, state: 'INACTIVE', payload: {
    version: first, verification: 'verified', proof_schema: 'worker-modules-sha256-v1',
    module_digest: servingDigest(artifact), build_digest: servingDigest(artifact),
  }};
  const cf = vi.fn(provider);
  const discover = async (records: object[]) => (await production(main, cf, health, records, {}, true)).rows[0];
  expect(await discover([record])).toMatchObject({sha, facts: {verification: 'verified'}});
  for (const other of [{...record, creator: 'other'}, {...record, sha: 'c'.repeat(40)},
    {...record, payload: {...record.payload, version: second}}, {...record, payload: {version: first}}]) {
    expect((await discover([other])).sha).toBeNull();
  }
  expect(cf.mock.calls.some(([path]) => path.includes('modules'))).toBe(false);
});

it('migrates a legacy success, keeps pending source separate from traffic, and deduplicates retries', async () => {
  const {reconcile, production} = await observer();
  const {servingDigest} = await loadProof();
  const nodes = [{databaseId: 1, task: 'record_steward_status', commitOid: sha,
    payload: JSON.stringify(JSON.stringify({key: deployment + '/' + first})), latestStatus: {state: 'SUCCESS'}}];
  const writes: string[] = [];
  const gh = async (path: string, body: any) => {
    if (path === 'graphql') return {data: {repository: {deployments: {nodes, pageInfo: {hasNextPage: false}}}}};
    if (path === 'deployments') {
      nodes.push({databaseId: nodes.length + 1, task: body.task, commitOid: body.ref,
        payload: JSON.stringify(body.payload), latestStatus: {state: ''}});
      return {id: nodes.length, sha: body.ref, environment: body.environment};
    }
    const item = nodes.find(r => path === 'deployments/' + r.databaseId + '/statuses')!;
    item.latestStatus.state = body.state.toUpperCase();
    writes.push(item.databaseId + ' ' + body.state);
    return {state: body.state};
  };
  vi.stubEnv('GITHUB_SHA', 'b'.repeat(40));
  try {
    const summary = vi.fn();
    const run = (builds: object) => reconcile(gh, 'production', () => production(main, provider, health, [], builds), summary);
    await run({});
    expect(writes).toEqual(['2 pending', '3 pending', '1 inactive']);
    expect(nodes[2]!.commitOid).toBe('b'.repeat(40));
    expect(summary.mock.calls[0]![0]).toContain('25%');
    await run({[sha]: servingDigest(artifact)});
    await run({[sha]: servingDigest(artifact)});
    expect(writes.slice(3)).toEqual(['4 success', '2 inactive']);
  } finally {vi.unstubAllEnvs();}
});
