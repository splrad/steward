import {appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import apiVersion from '../config/github-api.json' with {type: 'json'};
import {latestControllerVersion} from './controller-version.mjs';
import {controllerSource} from './controller-source.mjs';

import {servingDigest} from './worker-module-proof.mjs';

const repo = 'splrad/steward';
const web = 'https://github.com/' + repo;
const api = 'https://api.github.com/repos/' + repo;
const healthURL = 'https://splrad-steward-runtime.alearner-5ef.workers.dev/health';
const task = 'record_steward_status';
const shaPattern = /^[0-9a-f]{40}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function requireFact(condition, message) {
  if (!condition) throw Error(message);
}

async function json(url, options = {}) {
  const response = await fetch(url, {...options, redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw Object.assign(Error('HTTP ' + response.status + ' from ' + new URL(url).hostname),
    {status: response.status});
  return response.json();
}

export function github(token) {
  requireFact(token, 'GitHub token is missing');
  return (path, body) => json(path === 'graphql' ? 'https://api.github.com/graphql' : api + '/' + path, {
    method: body ? 'POST' : 'GET',
    headers: {authorization: 'Bearer ' + token, 'x-github-api-version': apiVersion.version,
      accept: 'application/vnd.github+json', 'content-type': 'application/json'},
    body: body && JSON.stringify(body),
  });
}

export function cloudflare(account, token) {
  requireFact(/^[0-9a-f]{32}$/.test(account) && token, 'Cloudflare observer configuration is missing');
  return async path => {
    const data = await json('https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/' + path,
      {headers: {authorization: 'Bearer ' + token}});
    requireFact(data.success === true, 'Cloudflare read failed');
    return data.result;
  };
}

export async function governance(gh) {
  const source = await gh('git/ref/heads/' + controllerSource);
  const refs = await gh('git/matching-refs/tags/controller-v');
  requireFact(refs.every(ref => ref.object.type === 'commit'), 'Invalid controller tag target');
  const version = latestControllerVersion(refs.map(r => r.object.sha + '\t' + r.ref).join('\n'));
  requireFact(version && source.object.type === 'commit' && source.object.sha === version.sha,
    'Controller branch and latest version tag do not yet agree');
  return {snapshot: version.tag, rows: [{key: version.tag, sha: version.sha, label: version.tag,
    url: web + '/tree/' + version.tag, facts: {tag: version.tag}}]};
}

export function versionSource(version) {
  const annotations = version.annotations ?? {};
  const tag = annotations['workers/tag'] ?? '';
  const message = annotations['workers/message'] ?? '';
  const sources = new Set([...message.matchAll(/(?:^|\s)source-sha=([0-9a-f]{40})(?=\s|$)/g)].map(match => match[1]));
  const tagged = /^(?:git-)?([0-9a-f]{40})$/.exec(tag);
  if (tagged) sources.add(tagged[1]);
  // Earlier Steward uploads used rel-<short SHA>-cfgN plus a full SHA in the version message.
  const legacy = /^rel-([0-9a-f]{7,40})(?:-cfg\d+)?$/.exec(tag);
  if (legacy) {
    const suffix = /\s([0-9a-f]{40})$/.exec(message);
    if (suffix) sources.add(suffix[1]);
    if ([...sources].some(sha => !sha.startsWith(legacy[1]))) return null;
  }
  // Console uploads for a reviewed Steward PR use a short tag and a full SHA in the message.
  const steward = /^steward-([0-9a-f]{7,40})$/.exec(tag);
  if (steward) {
    const release = /^Steward #[1-9][0-9]* ([0-9a-f]{40})$/.exec(message);
    if (release) sources.add(release[1]);
    if ([...sources].some(sha => !sha.startsWith(steward[1]))) return null;
  }
  return sources.size === 1 ? [...sources][0] : null;
}

const proofSchema = 'worker-modules-sha256-v1';
const digestPattern = /^[0-9a-f]{64}$/;
const actionsBot = 'MDM6Qm90NDE4OTgyODI=';

export function knownProof(records, version, sha) {
  if (!sha) return null;
  return records.find(record => record.creator === actionsBot && record.sha === sha &&
    record.payload.proof_schema === proofSchema && record.payload.version === version &&
    record.payload.verification === 'verified' && digestPattern.test(record.payload.module_digest) &&
    record.payload.module_digest === record.payload.build_digest)?.payload ?? null;
}

const verificationLabels = {
  verified: '模块已核实', mismatch: '模块与重建结果不符', unavailable: '模块待核实',
  off_main: '声明提交未确认在主线', undeclared: '无明确源码声明',
};

export async function production(gh, cf, health = () => json(healthURL), records = [], builds = {}, discovery = false) {
  const worker = 'splrad-steward-runtime';
  const latest = async () => (await cf('scripts/' + worker + '/deployments?per_page=1')).deployments[0];
  const deployment = await latest();
  const traffic = deployment?.versions;
  requireFact(uuidPattern.test(deployment?.id) && Array.isArray(traffic) && traffic.length &&
    traffic.every(v => uuidPattern.test(v.version_id) && Number.isFinite(v.percentage) && v.percentage >= 0) &&
    new Set(traffic.map(v => v.version_id)).size === traffic.length &&
    Math.abs(traffic.reduce((sum, v) => sum + v.percentage, 0) - 100) < 1e-6, 'Invalid Cloudflare traffic allocation');
  const rows = [];
  for (const {version_id: id, percentage} of traffic.filter(v => v.percentage > 0)) {
    const version = await cf('workers/' + worker + '/versions/' + id);
    requireFact(version.id === id, 'Unexpected Worker version');
    const declared = versionSource(version);
    let onMain = false;
    if (declared) {
      try {
        const main = await gh('compare/' + declared + '...main?per_page=1');
        onMain = main.merge_base_commit?.sha === declared && ['ahead', 'identical'].includes(main.status);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    const known = onMain && knownProof(records, id, declared);
    let digest = known?.module_digest ?? null;
    let verification = known ? 'verified' : !declared ? 'undeclared' : !onMain ? 'off_main' : 'unavailable';
    if (!known && onMain && !discovery && digestPattern.test(builds[declared])) {
      try {
        const uploaded = await cf('workers/' + worker + '/versions/' + id + '?include=modules');
        requireFact(uploaded.id === id, 'Unexpected Worker modules response');
        digest = servingDigest(uploaded);
        if (digest) verification = digest === builds[declared] ? 'verified' : 'mismatch';
      } catch {
        // The allocation and main ancestry are still known if module retrieval is temporarily unavailable.
        console.warn('Unable to confirm Worker modules for', id);
      }
    }
    const verified = verification === 'verified';
    const label = 'Worker ' + id + ' · ' + percentage + '% · ' + verificationLabels[verification];
    rows.push({key: [proofSchema, deployment.id, id].join('/'), sha: verified ? declared : null,
      label, url: healthURL, facts: {deployment: deployment.id, deployed_at: deployment.created_on, version: id, percentage,
        declared_sha: declared, on_main: onMain, verification, proof_schema: proofSchema, module_digest: digest,
        build_digest: known?.build_digest ?? builds[declared] ?? null}});

  }
  const live = await health();
  requireFact(live.status === 'ok' && rows.some(r => r.facts.version === live.version),
    'Public health and Cloudflare traffic allocation disagree');
  requireFact((await latest())?.id === deployment.id, 'Production changed during observation');
  return {snapshot: deployment.id, rows};
}

const historyQuery = `query($environment: String!, $after: String) {
  repository(owner: "splrad", name: "steward") {
    deployments(environments: [$environment], first: 100, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { databaseId creator { ... on Bot { id } } task commitOid payload latestStatus { state description creator { ... on Bot { id } } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function history(gh, environment) {
  const records = [];
  let after = null;
  do {
    const result = await gh('graphql', {query: historyQuery, variables: {environment, after}});
    requireFact(!result.errors && result.data?.repository?.deployments, 'GitHub deployment history unavailable');
    const {nodes, pageInfo} = result.data.repository.deployments;
    for (const row of nodes.filter(r => r.task === task)) {
      // GraphQL serializes a REST deployment's JSON payload as a JSON string scalar.
      let payload = row.payload;
      for (let layer = 0; layer < 2 && typeof payload === 'string'; layer++) payload = JSON.parse(payload);
      requireFact(typeof payload?.key === 'string' && Number.isSafeInteger(row.databaseId), 'Malformed Steward receipt');
      records.push({id: row.databaseId, sha: row.commitOid, key: payload.key, payload, creator: row.creator?.id,
        state: row.latestStatus?.state, statusCreator: row.latestStatus?.creator?.id, description: row.latestStatus?.description});
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);
  return records;
}

function summary(row) {
  const link = sha => '[' + sha.slice(0, 12) + '](' + web + '/commit/' + sha + ')';
  if (!row.facts.verification) return '- ' + row.label + ' · ' + link(row.sha);
  const f = row.facts;
  const lines = ['- ' + row.label, '  - 上传者声明的源码提交 ' + (f.declared_sha ? link(f.declared_sha) : '未知') +
    '，主线归属' + (f.on_main ? '已确认' : '未确认')];
  if (f.module_digest) lines.push('  - Cloudflare 模块清单 SHA-256 `' + f.module_digest + '`');
  if (f.build_digest) lines.push('  - 隔离重建模块清单 SHA-256 `' + f.build_digest + '`');
  if (!row.sha) lines.push('  - Cloudflare 已确认上述生产流量。GitHub pending 表示此版本的源码关联待核实。');
  return lines.join('\n');
}

export async function reconcile(gh, environment, observe, writeSummary = console.log) {
  const records = await history(gh, environment);
  const previous = records.filter(record => record.state !== 'INACTIVE');
  const observed = await observe(records);
  const keep = new Set();
  await writeSummary('### ' + environment + '\n\n' + observed.rows.map(summary).join('\n') + '\n');
  for (const row of observed.rows) {
    const pending = !row.sha && environment === 'production';
    // GitHub requires a ref even for a pending observation. Use the observer commit if no main claim exists.
    // The label and run summary distinguish this anchor from a verified deployed commit.
    const prior = previous.find(item => item.creator === actionsBot && item.key === row.key &&
      Object.entries(row.facts).every(([field, value]) => item.payload[field] === value));
    const ref = row.sha ?? (row.facts.on_main ? row.facts.declared_sha : prior?.sha ?? process.env.GITHUB_SHA);
    requireFact(shaPattern.test(ref), 'Invalid receipt commit');
    const label = pending && !row.facts.on_main ? row.label + ' · 提交仅标识观察点' : row.label;
    let record = prior?.sha === ref ? prior : null;
    if (!record) {
      const created = await gh('deployments', {ref, task, environment, auto_merge: false, required_contexts: [],
        production_environment: environment === 'production', description: label, payload: {key: row.key, ...row.facts}});
      requireFact(Number.isSafeInteger(created.id) && created.sha === ref && created.environment === environment,
        'GitHub deployment creation was not confirmed');
      record = {id: created.id};
    }
    keep.add(record.id);
    const state = pending ? 'pending' : 'success';
    if (record.state !== state.toUpperCase() || record.statusCreator !== actionsBot || record.description !== label) {
      const runId = process.env.GITHUB_RUN_ID;
      const evidence = /^\d+$/.test(runId ?? '') ? web + '/actions/runs/' + runId : api + '/deployments/' + record.id;
      const status = await gh('deployments/' + record.id + '/statuses', {state, auto_inactive: false,
        environment_url: environment === 'production' ? evidence : row.url, log_url: evidence, description: label});
      requireFact(status.state === state, 'GitHub receipt was not confirmed');
    }
  }
  for (const old of previous.filter(item => !keep.has(item.id))) {
    const status = await gh('deployments/' + old.id + '/statuses', {state: 'inactive', auto_inactive: false,
      description: 'Superseded by the current ' + environment + ' observation'});
    requireFact(status.state === 'inactive', 'Previous receipt was not retired');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gh = github(process.env.GH_TOKEN);
  const mode = process.argv[2];
  requireFact(['production', 'production-sources', 'governance-promotion'].includes(mode), 'Unknown receipt mode');
  const cf = mode.startsWith('production') && cloudflare(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_WORKERS_READ_TOKEN);
  if (mode === 'production-sources') {
    const records = await history(gh, 'production');
    const {rows} = await production(gh, cf, undefined, records, {}, true);
    const sources = [...new Set(rows.filter(r => r.facts.on_main && !r.sha).map(r => r.facts.declared_sha))];
    await appendFile(process.env.GITHUB_OUTPUT, 'sources=' + JSON.stringify(sources) + '\n');
  } else {
    const observe = mode === 'production'
      ? records => production(gh, cf, undefined, records, JSON.parse(process.env.BUILD_DIGESTS || '{}'))
      : () => governance(gh);
    await reconcile(gh, mode, observe, async text => {
      console.log(text);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
    });
  }
}
