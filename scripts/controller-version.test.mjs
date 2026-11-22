import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapControllerVersion, controllerVersionNumber, latestControllerVersion, publishControllerVersion} from './controller-version.mjs';

const appId = 5639432;
const sha = n => n.toString(16).padStart(40, '0');
const ref = number => 'refs/tags/controller-v' + number;
const branch = 'refs/heads/steward/validated-controller';
const refValue = (name, commit) => ({ref: name, object: {type: 'commit', sha: commit}});

function fixture({versions = 999, target = 1000, loseResponse = false} = {}) {
  const tags = new Map(Array.from({length: versions}, (_, index) => [ref(index + 1), sha(index + 1)]));
  const history = [];
  const source = {target};
  const conditions = {repository_id: {repository_ids: [1296724484]}, ref_name: {include: ['refs/tags/controller-v*'], exclude: []}};
  const baseRule = {source: 'splrad', source_type: 'Organization', target: 'tag', enforcement: 'active', conditions};
  const rules = {
    27857927: {...baseRule, id: 27857927, bypass_actors: [], rules: [
      {type: 'deletion'}, {type: 'update', parameters: {update_allows_fetch_and_merge: false}},
    ]},
    27857928: {...baseRule, id: 27857928, bypass_actors: [
      {actor_id: appId, actor_type: 'Integration', bypass_mode: 'always'},
    ], rules: [{type: 'creation'}]},
  };
  const io = {async request(method, path, body) {
    if (path.startsWith('/orgs/splrad/rulesets/')) return {status: 200, value: rules[path.split('/').at(-1)]};
    if (path.endsWith('/git/ref/heads/steward%2Fvalidated-controller')) {
      return {status: 200, value: refValue(branch, sha(source.target))};
    }
    if (path.includes('/compare/')) {
      const [base, head] = path.split('/').at(-1).split('...');
      return {status: 200, value: {status: base < head ? 'ahead' : 'behind',
        base_commit: {sha: base}, merge_base_commit: {sha: base}}};
    }
    if (path.includes('/git/ref/tags/')) {
      const name = 'refs/tags/' + path.split('/').at(-1);
      return tags.has(name) ? {status: 200, value: refValue(name, tags.get(name))} : {status: 404};
    }
    assert.equal(path, '/repos/splrad/steward/git/refs');
    assert.equal(method, 'POST');
    history.push(body);
    tags.set(body.ref, body.sha);
    if (loseResponse) throw Error('lost response');
    return {status: 201};
  }};
  const read = async () => [...tags].sort(([a], [b]) => a.localeCompare(b)).map(([name, commit]) => commit + '\t' + name).join('\n');
  return {io, source, rules, history, read};
}

test('finds the highest numeric version in a Git ref list of more than one thousand entries', async () => {
  const data = fixture({versions: 1105});
  assert.deepEqual(latestControllerVersion(await data.read()), {number: 1105, tag: 'controller-v1105', sha: sha(1105)});
  assert.equal(controllerVersionNumber('controller-v1000'), 1000);
  assert.equal(controllerVersionNumber('controller-v0100'), null);
});
test('publishes version 1000 once and recovers a lost write by exact readback', async () => {
  const data = fixture({loseResponse: true});
  const publish = () => publishControllerVersion(data.io, sha(1000), appId, async () => {}, data.read);
  assert.deepEqual(await publish(), {status: 'PUBLISHED', tag: 'controller-v1000', sha: sha(1000)});
  assert.deepEqual(await publish(), {status: 'ALREADY_PUBLISHED', tag: 'controller-v1000', sha: sha(1000)});
  assert.deepEqual(data.history, [{ref: ref(1000), sha: sha(1000)}]);
});
test('records the previous protected source as the baseline before issuing its successor', async () => {
  const data = fixture({versions: 0, target: 101});
  assert.deepEqual(await bootstrapControllerVersion(data.io, appId, async () => {}, data.read),
    {status: 'PUBLISHED', tag: 'controller-v1', sha: sha(101)});
  data.source.target = 102;
  assert.deepEqual(await publishControllerVersion(data.io, sha(102), appId, async () => {}, data.read),
    {status: 'PUBLISHED', tag: 'controller-v2', sha: sha(102)});
  assert.equal(await bootstrapControllerVersion(data.io, appId, async () => {}, data.read), null);
});
test('refuses to number a moved source, a downgrade, or a namespace with widened permissions', async () => {
  const data = fixture();
  const publish = target => publishControllerVersion(data.io, sha(target), appId, async () => {}, data.read);
  await assert.rejects(publish(1001), /CONTROLLER_VERSION_SOURCE_MOVED/);
  data.source.target = 998;
  await assert.rejects(publish(998), /CONTROLLER_VERSION_NOT_DESCENDANT/);
  data.rules[27857927].bypass_actors.push({actor_id: appId, actor_type: 'Integration', bypass_mode: 'always'});
  await assert.rejects(publish(998), /CONTROLLER_VERSION_RULE_SCOPE/);
  assert.equal(data.history.length, 0);
});
