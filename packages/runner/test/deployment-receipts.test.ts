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

it('reports each active allocation, including unmapped versions, and rejects stale health', async () => {
  const {production} = await observer();
  const versions = [{version_id: first, percentage: 75}, {version_id: second, percentage: 25}];
  const cf = async (path: string) => {
    if (path.includes('deployments?')) return {deployments: [{id: deployment, versions}]};
    const id = path.split('/').at(-1);
    return {id, annotations: id === first ? {'workers/tag': sha} : {}};
  };
  const gh = async () => ({status: 'ahead', merge_base_commit: {sha}});
  expect((await production(gh, cf, async () => ({status: 'ok', version: second}))).rows)
    .toMatchObject([{sha, facts: {version: first, percentage: 75}}, {sha: null, facts: {version: second, percentage: 25}}]);
  await expect(production(gh, cf, async () => ({status: 'ok', version: deployment}))).rejects.toThrow('disagree');
  const missing = async () => {throw Object.assign(Error(), {status: 404});};
  expect((await production(missing, cf, async () => ({status: 'ok', version: first}))).rows[0].sha).toBeNull();
});

it('reuses a partially written receipt, retires the previous deployment and deduplicates repeated reads', async () => {
  const {reconcile} = await observer();
  const row = {key: deployment + '/' + first, sha, label: 'Worker version', url: 'https://example.test', facts: {}};
  const old = {databaseId: 1, task: 'record_steward_status', commitOid: sha,
    payload: JSON.stringify(JSON.stringify({key: 'old-deployment/' + first})), latestStatus: {state: 'SUCCESS'}};
  const current = {...old, databaseId: 2, payload: JSON.stringify(JSON.stringify({key: row.key})), latestStatus: {state: ''}};
  const nodes = [current, old];
  const writes: string[] = [];
  const gh = async (path: string, body: any) => {
    if (path === 'graphql') return {data: {repository: {deployments: {nodes, pageInfo: {hasNextPage: false}}}}};
    const item = nodes.find(r => path === 'deployments/' + r.databaseId + '/statuses');
    if (!item) throw Error('Unexpected deployment creation');
    item.latestStatus.state = body.state.toUpperCase();
    writes.push(path + ' ' + body.state);
    return {state: body.state};
  };
  const read = async () => ({rows: [row]});
  await reconcile(gh, 'production', read, vi.fn());
  await reconcile(gh, 'production', read, vi.fn());
  expect(writes).toEqual(['deployments/2/statuses success', 'deployments/1/statuses inactive']);
  const summary = vi.fn();
  await expect(reconcile(gh, 'production', async () => ({rows: [{...row, key: 'new', sha: null}]}), summary))
    .rejects.toThrow('no verified main commit');
  expect(writes.at(-1)).toBe('deployments/2/statuses inactive');
  expect(summary.mock.calls[0]![0]).toContain('源码提交待核实');
});
