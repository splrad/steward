import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publishPromotedSources} from './governance-promotion.mjs';
import {
  bootstrapControllerVersion, controllerTagPrefix, controllerVersionNumber, latestControllerVersion, publishControllerVersion,
} from './controller-version.mjs';

const appId = 5639432;
const sha = n => n.toString(16).padStart(40, '0');
const ref = number => controllerTagPrefix + number;
const branch = 'refs/heads/steward/validated-controller';
const refValue = (name, commit) => ({ref: name, object: {type: 'commit', sha: commit}});

function fixture({versions = 999, target = 1000, loseResponse = false} = {}) {
  const tags = new Map(Array.from({length: versions}, (_, index) => [ref(index + 1), sha(index + 1)]));
  const history = [];
  const source = {target};
  const conditions = {repository_id: {repository_ids: [1296724484]}, ref_name: {include: ['refs/tags/controller-v*', 'refs/tags/controller-v*/**/*'], exclude: []}};
  const baseRule = {source: 'splrad', source_type: 'Organization', target: 'tag', enforcement: 'active', conditions};
  const rules = {
    26970367: {id: 26970367, source: 'splrad', source_type: 'Organization', target: 'branch', enforcement: 'active',
      conditions: {repository_id: {repository_ids: [1296724484]}, ref_name: {include: [branch], exclude: []}},
      bypass_actors: [{actor_id: appId, actor_type: 'Integration', bypass_mode: 'always'}],
      rules: [{type: 'creation'}, {type: 'update', parameters: {update_allows_fetch_and_merge: false}}]},
    26970366: {id: 26970366, source: 'splrad', source_type: 'Organization', target: 'tag', enforcement: 'active',
      conditions: {repository_id: {repository_ids: [1296724484]}, ref_name: {include: ['refs/tags/steward/validated-controller'], exclude: []}},
      bypass_actors: [], rules: [{type: 'creation'}, {type: 'deletion'},
        {type: 'update', parameters: {update_allows_fetch_and_merge: false}}]},
    26970365: {id: 26970365, source: 'splrad', source_type: 'Organization', target: 'branch', enforcement: 'active',
      conditions: {repository_id: {repository_ids: [1296724484]}, ref_name: {include: [branch], exclude: []}},
      bypass_actors: [], rules: [{type: 'deletion'}, {type: 'non_fast_forward'}]},
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
    if (path.endsWith('/git/refs/heads/steward%2Fvalidated-controller')) {
      assert.equal(method, 'PATCH');
      assert.equal(body.force, false);
      history.push(body);
      source.target = Number.parseInt(body.sha, 16);
      return {status: 200, value: refValue(branch, body.sha)};
    }
    if (path.endsWith('/git/matching-refs/tags/')) {
      return {status: 200, value: [...tags].map(([name, commit]) => refValue(name, commit))};
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
  const read = async () => [...tags].filter(([name]) => name.startsWith(controllerTagPrefix))
    .sort(([a], [b]) => a.localeCompare(b)).map(([name, commit]) => commit + '\t' + name).join('\n');
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
  data.rules[27857928].conditions = structuredClone(data.rules[27857928].conditions);
  data.rules[27857928].conditions.ref_name.include.pop();
  await assert.rejects(publish(998), /CONTROLLER_VERSION_RULE_SCOPE/);
  data.rules[27857928].conditions.ref_name.include.push('refs/tags/controller-v*/**/*');
  data.rules[27857927].bypass_actors.push({actor_id: appId, actor_type: 'Integration', bypass_mode: 'always'});
  await assert.rejects(publish(998), /CONTROLLER_VERSION_RULE_SCOPE/);
  data.rules[27857927].bypass_actors.pop();
  data.rules[26970365].rules.pop();
  await assert.rejects(publish(998), /CONTROLLER_SOURCE_RULE_TYPES/);
  assert.equal(data.history.length, 0);
});

test('the production promotion coordinator records the baseline, advances the source, then publishes the successor once', async () => {
  const data = fixture({versions: 0, target: 101});
  const plan = {status: 'UNCHANGED', commit: sha(102), tags: {}};
  const records = [];
  const publish = () => publishPromotedSources(data.io, plan, sha(102), appId, async () => {},
    async value => records.push(value), data.read);
  await publish();
  assert.deepEqual(data.history, [
    {ref: ref(1), sha: sha(101)},
    {sha: sha(102), force: false},
    {ref: ref(2), sha: sha(102)},
  ]);
  const receipts = () => records.filter(value => /^(?:controller-version-(?:baseline|result)|controller-source-result)$/.test(value.kind))
    .map(({kind, status, tag}) => [kind, status, tag]);
  assert.deepEqual(receipts(), [
    ['controller-version-baseline', 'PUBLISHED', 'controller-v1'],
    ['controller-source-result', 'PUBLISHED', undefined],
    ['controller-version-result', 'PUBLISHED', 'controller-v2'],
  ]);
  records.length = 0;
  await publish();
  assert.equal(data.history.length, 3);
  assert.deepEqual(receipts(), [
    ['controller-source-result', 'ALREADY_PUBLISHED', undefined],
    ['controller-version-result', 'ALREADY_PUBLISHED', 'controller-v2'],
  ]);
});

test('version-rule failures leave template publication untouched before its write or already woken afterward', async () => {
  const data = fixture({versions: 0, target: 101});
  const target = sha(102);
  const tag = 'v1.0.1';
  const templateRef = 'refs/tags/' + tag;
  const newTemplate = {status: 'CREATE', commit: target, tag, tags: {}};
  let wakes = 0;
  let failVersionRules = true;
  const io = {async request(method, path, body) {
    if (path.endsWith('/rulesets/27857928') && failVersionRules) return {status: 503};
    if (path.endsWith('/dispatches')) {
      assert.equal(method, 'POST');
      assert.equal(body.event_type, 'steward-template-event');
      wakes++;
      failVersionRules = true;
      return {status: 204};
    }
    return data.io.request(method, path, body);
  }};
  const publish = plan => publishPromotedSources(io, plan, target, appId, async () => {}, async () => {}, data.read);

  await assert.rejects(publish(newTemplate), /CONTROLLER_VERSION_READ/);
  assert.deepEqual(data.history, []);
  assert.equal(wakes, 0);

  failVersionRules = false;
  await assert.rejects(publish(newTemplate), /CONTROLLER_VERSION_READ/);
  assert.deepEqual(data.history, [
    {ref: ref(1), sha: sha(101)}, {ref: templateRef, sha: target}, {sha: target, force: false},
  ]);
  assert.equal(wakes, 1);

  failVersionRules = false;
  await publish({status: 'UNCHANGED', commit: target, tags: {[templateRef]: target}});
  assert.equal(wakes, 1);
  assert.deepEqual(data.history.at(-1), {ref: ref(2), sha: target});
});
