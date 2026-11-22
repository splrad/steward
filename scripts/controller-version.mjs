import {isDeepStrictEqual} from 'node:util';
import {controllerSource} from './controller-source.mjs';
import {completeNativeRuleParameters} from './native-rule-parameters.mjs';

export const controllerTagPrefix = 'refs/tags/controller-v';
const repo = '/repos/splrad/steward';
const integrityRule = 27857927;
const writerRule = 27857928;
const scope = {repository_id: {repository_ids: [1296724484]}, ref_name: {include: [controllerTagPrefix + '*'], exclude: []}};
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const check = (ok, code) => { if (!ok) throw Error('CONTROLLER_VERSION_' + code); };

export function controllerVersionNumber(tag) {
  const match = typeof tag === 'string' && /^controller-v([1-9][0-9]*)$/.exec(tag);
  const number = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function latestControllerVersion(refs) {
  let latest = null;
  const commits = new Set();
  const versions = new Set();
  for (const line of refs.split(/\r?\n/).filter(Boolean)) {
    const [commit, ref, ...extra] = line.split('\t');
    const tag = ref?.startsWith(controllerTagPrefix) && ref.slice('refs/tags/'.length);
    const number = controllerVersionNumber(tag);
    check(sha(commit) && number && !extra.length && !commits.has(commit) && !versions.has(number), 'REFS');
    commits.add(commit);
    versions.add(number);
    if (!latest || number > latest.number) latest = {number, tag, sha: commit};
  }
  return latest;
}

async function read(io, path, allowAbsent = false) {
  const {status, value} = await io.request('GET', path);
  if (allowAbsent && status === 404) return null;
  if (status !== 200) throw Object.assign(Error('CONTROLLER_VERSION_READ'), {status});
  check(value != null, 'READ');
  return value;
}

async function assertVersionProtection(io, appId) {
  check(Number.isSafeInteger(appId) && appId > 0, 'APP');
  for (const [id, types, actors] of [
    [integrityRule, ['deletion', 'update'], []],
    [writerRule, ['creation'], [{actor_type: 'Integration', actor_id: appId, bypass_mode: 'always'}]],
  ]) {
    const rule = await completeNativeRuleParameters(io, await read(io, '/orgs/splrad/rulesets/' + id));
    check(rule.id === id && rule.target === 'tag' && rule.enforcement === 'active'
      && rule.source === 'splrad' && rule.source_type === 'Organization', 'RULE_IDENTITY');
    check(isDeepStrictEqual(rule.conditions, scope) && isDeepStrictEqual(rule.bypass_actors, actors), 'RULE_SCOPE');
    check(Array.isArray(rule.rules) && isDeepStrictEqual(rule.rules.map(value => value.type).sort(), types), 'RULE_TYPES');
    check(rule.rules.every(value => value.type !== 'update'
      || value.parameters?.update_allows_fetch_and_merge === false), 'RULE_UPDATE');
  }
}

async function protectedController(io) {
  const ref = await read(io, repo + '/git/ref/heads/' + encodeURIComponent(controllerSource), true);
  if (!ref) return null;
  check(ref.ref === 'refs/heads/' + controllerSource && ref.object?.type === 'commit' && sha(ref.object.sha), 'SOURCE');
  return ref.object.sha;
}

/** Record the current protected source before its first advance, so retries retain the baseline. */
export async function bootstrapControllerVersion(io, appId, assertCurrent, readRefs) {
  await assertCurrent();
  await assertVersionProtection(io, appId);
  if (latestControllerVersion(await readRefs())) return null;
  const baseline = await protectedController(io);
  return baseline ? publishControllerVersion(io, baseline, appId, assertCurrent, readRefs) : null;
}

export async function publishControllerVersion(io, target, appId, assertCurrent, readRefs) {
  check(sha(target), 'TARGET');
  const guard = async () => {
    await assertCurrent();
    await assertVersionProtection(io, appId);
    check(await protectedController(io) === target, 'SOURCE_MOVED');
  };
  await guard();
  const latest = latestControllerVersion(await readRefs());
  if (latest?.sha === target) {
    await guard();
    return {status: 'ALREADY_PUBLISHED', tag: latest.tag, sha: target};
  }
  if (latest) {
    const comparison = await read(io, repo + '/compare/' + latest.sha + '...' + target);
    check(comparison.status === 'ahead' && comparison.base_commit?.sha === latest.sha
      && comparison.merge_base_commit?.sha === latest.sha, 'NOT_DESCENDANT');
  }
  const number = (latest?.number ?? 0) + 1;
  check(Number.isSafeInteger(number), 'NUMBER');
  const ref = controllerTagPrefix + number;
  const tag = ref.slice('refs/tags/'.length);
  const path = repo + '/git/ref/tags/' + tag;
  const matches = observed => observed?.ref === ref && observed.object?.type === 'commit' && observed.object.sha === target;
  const before = await read(io, path, true);
  if (matches(before)) {
    await guard();
    return {status: 'ALREADY_PUBLISHED', tag, sha: target};
  }
  check(before === null, 'TAG_COLLISION');
  await guard();
  // Check authoritative readback after a success or after a lost response.
  try { await io.request('POST', repo + '/git/refs', {ref, sha: target}); } catch {}
  check(matches(await read(io, path, true)), 'WRITE_UNCONFIRMED');
  await guard();
  return {status: 'PUBLISHED', tag, sha: target};
}
