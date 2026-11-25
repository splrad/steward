import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Octokit } from '@octokit/rest';
import apiVersion from '../config/github-api.json' with { type: 'json' };
import { copilotReleaseClient, nativeReleaseApp } from '../packages/runner/dist/index.js';
import { authenticatedBotIdentityTransport } from './steward-bot-identity.mjs';

const label = 'Internal';
const appBot = 301115370;
const internal = name => name?.toLowerCase() === 'internal';
// A delivery admitted while open can finish after the exact change was merged.
const live = (pr, target) => pr.number === target.number &&
  ((pr.state === 'open' && !pr.merged) || (pr.state === 'closed' && pr.merged === true)) &&
  pr.base?.repo?.id === target.repositoryId && pr.base.ref === target.branch && pr.head.sha === target.head;

export function impactTarget(payload) {
  const repo = payload?.repository, pr = payload?.pull_request;
  const correction = ['labeled', 'unlabeled'].includes(payload?.action) && internal(payload.label?.name) &&
    Number.isSafeInteger(payload.sender?.id) && payload.sender.id !== appBot;
  if ((!correction && !['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review'].includes(payload?.action)) ||
      repo?.owner?.id !== 302208797 || !/^splrad\/[\w.-]+$/i.test(repo.full_name) ||
      !Number.isSafeInteger(repo.id) || repo.archived || repo.disabled || repo.fork ||
      !Number.isSafeInteger(pr?.number) || pr.number < 1 || pr.state !== 'open' ||
      pr.base?.repo?.id !== repo.id || pr.base.ref !== repo.default_branch || !/^[a-f0-9]{40}$/.test(pr.head?.sha ?? '') ||
      (pr.user?.id === appBot && pr.head.ref === 'release-please--branches--' + repo.default_branch)) return null;
  return { repository: repo.full_name, repositoryId: repo.id, number: pr.number, head: pr.head.sha,
    branch: repo.default_branch, description: repo.description ?? '', correction,
    title: pr.title, body: pr.body ?? '' };
}

// A truncated or binary patch cannot establish that the entire change is internal.
function completeFiles(pr, files) {
  return files.length > 0 && files.length === pr.changed_files &&
    files.every(file => {
      if (typeof file.patch !== 'string') return false;
      const lines = file.patch.split('\n');
      return lines.filter(line => line.startsWith('+')).length === file.additions &&
        lines.filter(line => line.startsWith('-')).length === file.deletions;
    });
}

export async function classifyPull(target, io, classify) {
  const state = async () => {
    const pr = await io.pull();
    if (!live(pr, target)) return null;
    const events = (await io.events()).filter(event => ['labeled','unlabeled'].includes(event.event) && internal(event.label?.name));
    const latest = events.at(-1);
    const labeled = pr.labels.some(item => internal(item.name));
    // An existing label without a matching native actor is maintained by its owner.
    const owner = events.findLast(event => event.actor?.id !== appBot);
    const manual = Boolean(owner) || (latest ? (latest.event === 'labeled') !== labeled : labeled);
    return { pr, labeled, manual, owner, latest, eventId: latest?.id ?? null };
  };
  // REST label writes have no conditional version. A later App event may have
  // overtaken a maintainer. Restore the most recent owner's decision and never
  // classify a label event. Manual deliveries also run in the same PR queue.
  async function restoreOwner(snapshot) {
    if (!snapshot?.owner?.actor?.id || snapshot.latest.actor?.id !== appBot) return;
    const desired = snapshot.owner.event === 'labeled';
    if (snapshot.labeled === desired) return;
    const now = await state();
    if (!now || now.eventId !== snapshot.eventId || now.owner?.id !== snapshot.owner.id || now.labeled === desired) return;
    if (desired) await io.add();
    else await io.remove();
  }
  const before = await state();
  if (!before || before.manual || target.correction) {
    await restoreOwner(before);
    return 'preserved';
  }
  if (before.pr.title !== target.title || (before.pr.body ?? '') !== target.body) return 'superseded';
  let decision = 'eligible', unavailable = false;
  try {
    const files = await io.files();
    if (completeFiles(before.pr, files)) {
      const readme = await io.readme(before.pr.base.sha);
      if (readme.trim() || target.description.trim()) {
        const latest = await state();
        if (!latest || latest.manual || latest.eventId !== before.eventId || latest.pr.base.sha !== before.pr.base.sha ||
            latest.pr.title !== target.title || (latest.pr.body ?? '') !== target.body) return 'superseded';
        const {text} = await classify(JSON.stringify({ project: target.description, readme, title: before.pr.title,
          body: before.pr.body, files: files.map(({filename,previous_filename,status,patch}) => ({filename,previous_filename,status,patch})) }));
        const result = JSON.parse(text);
        if (!['internal','eligible'].includes(result?.decision) || typeof result.reason !== 'string' || !result.reason.trim())
          throw Error('IMPACT_RESULT');
        decision = result.decision;
      }
    }
  } catch { unavailable = true; }
  const writable = async () => {
    const now = await state();
    return now && !now.manual && now.eventId === before.eventId && now.pr.title === before.pr.title &&
      now.pr.body === before.pr.body && now.pr.base.sha === before.pr.base.sha;
  };
  if (!await writable()) return 'superseded';
  if (decision === 'internal' && !before.labeled) {
    await io.ensureLabel();
    if (!await writable()) return 'superseded';
    await io.add();
    await restoreOwner(await state());
  } else if (decision === 'eligible' && before.labeled) {
    await io.remove();
    await restoreOwner(await state());
  }
  if (unavailable) throw Error('IMPACT_CLASSIFICATION_UNAVAILABLE');
  return decision;
}

function impactIO(target, token) {
  const client = new Octokit({ auth: token, request: {headers:{'x-github-api-version':apiVersion.version}},
    log: { debug(){}, info(){}, warn(){}, error(){} } });
  const [owner, repo] = target.repository.split('/');
  const r = {owner, repo}, pull = {...r, pull_number:target.number}, issue = {...r, issue_number:target.number};
  return {
    pull: async () => (await client.rest.pulls.get(pull)).data,
    events: () => client.paginate(client.rest.issues.listEvents, {...issue, per_page:100}),
    files: () => client.paginate(client.rest.pulls.listFiles, {...pull, per_page:100}),
    readme: async ref => {
      try {
        const {data} = await client.rest.repos.getReadme({...r,ref});
        if (data.encoding !== 'base64' || !data.content) return '';
        const bytes = Buffer.from(data.content,'base64');
        if (bytes.includes(0)) return '';
        try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes); } catch { return ''; }
      } catch (e) { if (e.status === 404) return ''; throw e; }
    },
    ensureLabel: async () => {
      try { await client.rest.issues.getLabel({...r,name:label}); return; }
      catch (e) { if (e.status !== 404) throw e; }
      try { await client.rest.issues.createLabel({...r,name:label,color:'57606a',description:'项目内部维护，发行说明起草时排除'}); }
      catch (e) { if (e.status !== 422) throw e; await client.rest.issues.getLabel({...r,name:label}); }
    },
    add: () => client.rest.issues.addLabels({...issue,labels:[label]}),
    remove: () => client.rest.issues.removeLabel({...issue,name:label}),
  };
}

async function main(env) {
  const {sender, inputs} = JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || sender?.id !== appBot || env.GITHUB_ACTOR_ID !== String(appBot) ||
      env.GITHUB_REPOSITORY_ID !== '1296724484' || env.GITHUB_REF !== 'refs/heads/main') throw Error('IMPACT_DISPATCH');
  const app = await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY, authenticatedBotIdentityTransport(fetch,env.STEWARD_COPILOT_TOKEN));
  const target = impactTarget(await app.readPullDelivery(inputs.delivery));
  if (!target) return;
  const sdk = copilotReleaseClient(process.cwd(), env.STEWARD_COPILOT_TOKEN, 'classify');
  const outcome = await app.forRepository(target.repositoryId, token => classifyPull(target, impactIO(target, token), sdk.call),'release-label');
  process.stdout.write('Release impact classification: ' + outcome + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.env).catch(() => { process.stderr.write('IMPACT_CLASSIFICATION_UNAVAILABLE\n'); process.exitCode = 1; });
