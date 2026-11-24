import {appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import apiVersion from '../config/github-api.json' with {type: 'json'};
import {latestControllerVersion} from './controller-version.mjs';
import {controllerSource} from './controller-source.mjs';

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
    if (suffix && !suffix[1].startsWith(legacy[1])) return null;
    if (suffix) sources.add(suffix[1]);
  }
  return sources.size === 1 ? [...sources][0] : null;
}

export async function production(gh, cf, health = () => json(healthURL)) {
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
    let sha = versionSource(version);
    if (sha) {
      try {
        const main = await gh('compare/' + sha + '...main?per_page=1');
        if (main.merge_base_commit?.sha !== sha || !['ahead', 'identical'].includes(main.status)) sha = null;
      } catch (error) {
        if (error.status !== 404) throw error;
        sha = null;
      }
    }
    rows.push({key: deployment.id + '/' + id, sha, label: 'Worker ' + id + ' · ' + percentage + '%',
      url: healthURL, facts: {deployment: deployment.id, deployed_at: deployment.created_on, version: id, percentage}});
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
      nodes { databaseId task commitOid payload latestStatus { state } }
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
    for (const row of nodes.filter(r => r.task === task && r.latestStatus?.state !== 'INACTIVE')) {
      // GraphQL serializes a REST deployment's JSON payload as a JSON string scalar.
      let payload = row.payload;
      for (let layer = 0; layer < 2 && typeof payload === 'string'; layer++) payload = JSON.parse(payload);
      requireFact(typeof payload?.key === 'string' && Number.isSafeInteger(row.databaseId), 'Malformed Steward receipt');
      records.push({id: row.databaseId, sha: row.commitOid, key: payload?.key, state: row.latestStatus?.state});
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);
  return records;
}

export async function reconcile(gh, environment, observe, writeSummary = console.log) {
  const previous = await history(gh, environment);
  const observed = await observe();
  const keep = new Set();
  const missing = [];
  await writeSummary('### ' + environment + '\n\n' + observed.rows.map(r =>
    '- ' + r.label + ' — ' + (r.sha ? '[' + r.sha.slice(0, 12) + '](' + web + '/commit/' + r.sha + ')' : '源码提交待核实')).join('\n') + '\n');
  for (const row of observed.rows) {
    if (!row.sha) { missing.push(row.label); continue; }
    requireFact(shaPattern.test(row.sha), 'Invalid receipt commit');
    let record = previous.find(item => item.key === row.key && item.sha === row.sha);
    if (!record) {
      const created = await gh('deployments', {ref: row.sha, task, environment, auto_merge: false, required_contexts: [],
        production_environment: environment === 'production', description: row.label, payload: {key: row.key, ...row.facts}});
      requireFact(Number.isSafeInteger(created.id) && created.sha === row.sha && created.environment === environment,
        'GitHub deployment creation was not confirmed');
      record = {id: created.id};
    }
    keep.add(record.id);
    if (record.state !== 'SUCCESS') {
      const status = await gh('deployments/' + record.id + '/statuses', {state: 'success', auto_inactive: false,
        environment_url: row.url, log_url: row.url, description: row.label});
      requireFact(status.state === 'success', 'GitHub receipt was not confirmed');
    }
  }
  for (const old of previous.filter(item => !keep.has(item.id))) {
    const status = await gh('deployments/' + old.id + '/statuses', {state: 'inactive', auto_inactive: false,
      description: 'Superseded by the current ' + environment + ' observation'});
    requireFact(status.state === 'inactive', 'Previous receipt was not retired');
  }
  requireFact(!missing.length, 'A serving Worker version has no verified main commit. See the run summary.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gh = github(process.env.GH_TOKEN);
  const environment = process.argv[2];
  requireFact(['production', 'governance-promotion'].includes(environment), 'Unknown receipt environment');
  const observe = environment === 'production'
    ? () => production(gh, cloudflare(process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_WORKERS_READ_TOKEN))
    : () => governance(gh);
  await reconcile(gh, environment, observe, async text => {
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  });
}
