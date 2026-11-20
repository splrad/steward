import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { nativeReleaseApp, parseDeliveryConfig } from '../packages/runner/dist/index.js';
import apiVersion from '../config/github-api.json' with { type: 'json' };
import contract from '../config/settings-source-events.json' with { type: 'json' };
import { revisionReader } from './configuration-authorization.mjs';
import { commitFiles, must, positive, sha } from './configuration-native.mjs';
import { ciPath, deliveryPath, effectiveChannels, inspectRepository, jsonFile, pagesChoices, pagesPath,
  publishPath, versionsPath } from './configuration-view.mjs';
import { productWorkflows, selectableProductCI } from './validation-input.mjs';
import { checkedRegistration,parseRegistration } from './repository-registration-policy.mjs';
import { projectMergedRepositoryPolicy } from './repository-policy-publish.mjs';
import { adminId, centralId, isGovernanceBot, loadPrivateRequest, makePrivateRequest, readWake,
  registrationEvent, wakePayload } from './repository-registration-request.mjs';

const orgId = 302208797;
const governance = { id: 5639432, installation: 179184801 };
const stewardBot = 301115370;
const webFlow = 19864447;
const fields = ['productCi', 'release', 'site'];
const metadataFiles = ['sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS'];
const digest = text => createHash('sha256').update(text).digest('hex');
const githubOptions = {
  request: { headers: { 'x-github-api-version': apiVersion.version } },
  log: { debug() {}, info() {}, warn() {}, error() {} }
};

export function registrationIds(event, name) {
  const repo = event.repository;
  must(repo?.id === adminId && repo.full_name === 'splrad/steward-settings' &&
    repo.private === true && repo.default_branch === 'main', 'Invalid registration receiver');
  if (name === 'workflow_dispatch') return [positive(event.inputs?.repository_id)];
  must(name === 'repository_dispatch' && event.action === 'settings-source-event' &&
    isGovernanceBot(event.sender), 'Untrusted registration event');
  const payload = event.client_payload;
  must(payload && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(payload.delivery) &&
    /^[a-f0-9]{64}$/.test(payload.body_sha256) && Object.hasOwn(contract.actions, payload.event) &&
    contract.actions[payload.event].includes(payload.action) &&
    Object.keys(payload).every(key => ['delivery', 'event', 'action', 'body_sha256', 'repository_ids'].includes(key)),
  'Invalid registration metadata');
  if (!Object.hasOwn(payload, 'repository_ids')) return [];
  const allowed = ['repository', 'create'].includes(payload.event) ||
    payload.event === 'installation_repositories' && payload.action === 'added' ||
    payload.event === 'installation' && payload.action === 'created';
  const ids = payload.repository_ids;
  must(allowed && Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length &&
    ids.every(id => Number.isSafeInteger(id) && id > 0) &&
    (!['repository', 'create'].includes(payload.event) || ids.length === 1), 'Invalid registration targets');
  return ids;
}

export async function pushRegistrationIds(event, env, api) {
  must(event.repository?.id === adminId && event.repository.full_name === 'splrad/steward-settings' &&
    event.repository.private === true && event.repository.default_branch === 'main' &&
    event.ref === 'refs/heads/main' && event.after === env.GITHUB_SHA && [event.before,event.after].every(sha) &&
    !/^0{40}$/.test(event.before) && event.created === false && event.deleted === false && event.forced === false,
  'Untrusted registration commit');
  const target={owner:'splrad',repo:'steward-settings'};
  const tree=async treeSha=>{
    const {data}=await api.rest.git.getTree({...target,tree_sha:treeSha});
    must(data.truncated===false && Array.isArray(data.tree) &&
      new Set(data.tree.map(entry=>entry.path)).size===data.tree.length,'Incomplete registration tree');
    return data.tree;
  };
  const inventory=async commit=>{
    const directory=(await tree(commit)).find(entry=>entry.path==='repositories');
    if(!directory)return new Map();
    must(directory.type==='tree'&&directory.mode==='040000'&&sha(directory.sha),'Invalid registration directory');
    const entries=(await tree(directory.sha)).filter(entry=>/^[1-9][0-9]*\.json$/.test(entry.path));
    return new Map(entries.map(entry=>{
      must(entry.type==='blob'&&entry.mode==='100644'&&sha(entry.sha),'Invalid registration file');
      return [positive(entry.path.slice(0,-5)),entry.sha];
    }));
  };
  const [before,after]=await Promise.all([event.before,event.after].map(inventory));
  return [...after].filter(([id,digest])=>before.get(id)!==digest).map(([id])=>id).sort((a,b)=>a-b);
}

export function selectRegistrationTargets(ids, scope) {
  if(!scope)return ids;
  const allowed=scope.split(',').map(positive);
  must(new Set(allowed).size===allowed.length,'Invalid registration scope');
  return ids.filter(id=>allowed.includes(id));
}

function checkRepository(repo, id) {
  must(repo?.id === id && repo.owner?.id === orgId && repo.owner?.login === 'splrad' &&
    repo.full_name === 'splrad/' + repo.name && /^[A-Za-z0-9_.-]+$/.test(repo.name) &&
    typeof repo.default_branch === 'string' && repo.default_branch, 'Repository identity mismatch');
  return repo;
}

async function withScopedApp(key, app, repositoryId, permissions, operation) {
  must(key, 'Registration App credential is unavailable');
  const appApi = new Octokit({ ...githubOptions, authStrategy: createAppAuth,
    auth: { appId: app.id, privateKey: key.replace(/\\n/g, '\n') } });
  const { data: installation } = await appApi.request('GET /orgs/{org}/installation', { org: 'splrad' });
  must(installation.id === app.installation && installation.app_id === app.id &&
    installation.account?.id === orgId && !installation.suspended_at, 'Registration installation mismatch');
  const { token } = await appApi.auth({ type: 'installation', installationId: app.installation,
    repositoryIds: [repositoryId], permissions });
  const api = new Octokit({ ...githubOptions, auth: token });
  try {
    const { data: scope } = await api.request('GET /installation/repositories', { per_page: 100 });
    must(scope.total_count === 1 && scope.repositories.length === 1 &&
      scope.repositories[0].id === repositoryId, 'Registration token scope mismatch');
    const { data } = await api.request('GET /repositories/{id}', { id: repositoryId });
    const repo = checkRepository(data, repositoryId);
    api.target = { owner: repo.owner.login, repo: repo.name };
    return await operation(api, repo);
  } finally {
    await api.request('DELETE /installation/token');
  }
}

async function readHead(api, branch, missing = false) {
  const result = await api.rest.git.getRef({ ...api.target, ref: 'heads/' + branch }).catch(error => {
    if (missing && (error.status === 404 || error.status === 409)) return null;
    throw error;
  });
  if (!result) return null;
  must(result.data.ref === 'refs/heads/' + branch && result.data.object.type === 'commit' &&
    sha(result.data.object.sha), 'Invalid registration ref');
  return result.data.object.sha;
}

export function releaseRegistration(model, pending) {
  let release = null;
  if (model.delivery) {
    const delivery = parseDeliveryConfig(model.delivery);
    const matrix = model.publish?.jobs?.build?.strategy?.matrix?.include;
    const units = [];
    for (const unit of delivery.units) {
      if (!model.versions?.packages?.[unit.path] || !Array.isArray(matrix) ||
        !matrix.some(row => row?.unit === unit.id && typeof row.target === 'string' && row.target)) {
        pending.push('确认发行单元和构建入口 ' + unit.id);
        continue;
      }
      const channels = [];
      for (const channel of effectiveChannels(delivery, unit)) {
        let artifactIds = channel.artifactIds;
        if (!artifactIds && channel.id === 'winget') {
          const installers = unit.assets.filter(asset => /\.(?:exe|msi|msix|appx|msixbundle|appxbundle)$/i.test(asset.name));
          if (installers.length !== 1) {
            pending.push('确认 WinGet 安装文件 ' + unit.id);
            continue;
          }
          artifactIds = [installers[0].id];
        }
        channels.push({ ...channel, artifactIds: artifactIds ?? unit.assets.map(asset => asset.id),
          metadata: channel.metadata ?? (channel.id === 'winget' ? [] : metadataFiles) });
      }
      units.push({ id: unit.id, channels });
    }
    if (units.length) release = { buildWorkflow: publishPath, units };
  }
  return release;
}

export async function registrationProposal(repo, read) {
  const paths = [ciPath, deliveryPath, publishPath, versionsPath, pagesPath];
  const files = new Map((await Promise.all(paths.map(async path => [path, await read(path)])))
    .filter(([, text]) => text !== null));
  const ci = files.has(ciPath) ? JSON.parse(files.get(ciPath)) : [];
  const ciPaths = files.has(ciPath) ? productWorkflows(ci, ci) : [];
  for (const path of ciPaths) {
    const text = await read(path);
    if (text !== null) files.set(path, text);
  }
  const model = inspectRepository(files);
  const pending = [];
  const productCi = ciPaths.filter(path => model.workflows.some(workflow =>
    workflow.path === path && selectableProductCI(workflow, repo.default_branch)));
  if (productCi.length !== ciPaths.length) pending.push('复核产品 CI 工作流或触发条件');
  const release = releaseRegistration(model, pending);
  const choice = pagesChoices(model.pages);
  const validSiteUnit=choice.source!=='release'||release?.units.some(unit=>unit.id===choice.unit);
  let site = null;
  if (choice.build && choice.source && validSiteUnit) {
    site = { workflow: pagesPath, mode: 'build-only', source: choice.source,
      ...(choice.source === 'release' ? { unit: choice.unit } : {}) };
  }
  if (choice.build || choice.deploy) {
    if (!choice.source) pending.push('确认站点构建来源');
    else if (!validSiteUnit) pending.push('确认站点的正式 Release 单元');
    if (choice.deploy && !choice.build) pending.push('确认公开部署所需的站点构建选择');
    if (choice.deploy) pending.push('确认公开部署授权');
  }
  const matrix = model.publish?.jobs?.build?.strategy?.matrix?.include;
  const rows = Array.isArray(matrix) ? matrix : [];
  const releaseDetails = new Map((model.delivery?.units ?? []).map(unit => [unit.id, {
    assets: new Map(unit.assets.map(asset => [asset.id, asset.name])),
    targets: rows.filter(row => row?.unit === unit.id && typeof row.target === 'string' && row.target).map(row => row.target)
  }]));
  return { policy: checkedRegistration({ schemaVersion: 1, repositoryId: repo.id, repository: repo.full_name,
    productCi, release, site }, repo.id), pending, releaseDetails };
}

export function renderRegistrationPull(repo, source, proposal, current=null) {
  const policy=current ? {...current,repository:repo.full_name} : proposal.policy;
  const quote=value=>'`'+String(value).replace(/[`<>\r\n]/g,'')+'`';
  const list=values=>values.map(quote).join('、');
  const path='repositories/'+repo.id+'.json';
  const title='chore: 登记 '+repo.name+' 逐仓配置';
  const differences=current?fields.filter(key=>!isDeepStrictEqual(current[key],proposal.policy[key])):[];
  const needsReview=differences.length>0||proposal.pending.length>0;
  const lines=[
    '请在这张私有管理员仓 PR 中确认目标仓的治理选择。需要调整时，在 PR 分支编辑 '+quote(path)+
      ' 并提交修改，再从 **Files changed** 核对最终 JSON'+(needsReview?'，并处理下列待确认项':'')+
      '。确认后将草稿转为待审，按本仓流程审查合并。',
    '', '## 仓库与配置', '',
    '- 目标仓 '+quote(repo.full_name)+'（'+repo.id+'）',
    '- 目标仓默认分支提交 '+quote(source),
    '- 配置文件 '+quote(path),
    '- 本次修改 '+list(current?['repository']:['repository',...fields]),
    '- 产品 CI '+(list(policy.productCi)||'沿用组织公共检查'),
    '', '## 发行与产物', ''
  ];
  if(policy.release) {
    lines.push('- 正式构建入口 '+quote(policy.release.buildWorkflow));
    for(const unit of policy.release.units) {
      const details=proposal.releaseDetails?.get(unit.id);
      const targets=details?.targets.length? '，构建目标 '+list([...new Set(details.targets)]) : '';
      lines.push('- 发行单元 '+quote(unit.id)+targets);
      if(!unit.channels.length)lines.push('  - 发行渠道未配置');
      for(const channel of unit.channels) {
        lines.push('  - '+quote(channel.id)+'（'+(channel.required?'必需':'非必需')+'）· '+quote(channel.location));
        const assets=channel.artifactIds.map(id=>quote(id)+(details?.assets.get(id)?'（'+quote(details.assets.get(id))+'）':''));
        lines.push('    - 产品文件 '+(assets.join('、')||'无'));
        lines.push('    - 发布元数据 '+(list(channel.metadata)||'无'));
      }
    }
  } else lines.push('发行渠道未配置。');
  lines.push('','## 站点','');
  if(policy.site) {
    const {mode,source:siteSource,unit,workflow}=policy.site;
    lines.push('- 工作流 '+quote(workflow),
      '- 选择 '+(mode==='build-only'?'仅构建':'构建并部署'),
      '- 来源 '+(siteSource==='default-branch'?'默认分支':'正式 Release 单元 '+quote(unit)));
  } else lines.push('本次登记未启用站点。');
  if(needsReview) {
    lines.push('','## 待确认','');
    if(differences.length)lines.push('- 仓内声明与已采用配置有差异，需审阅 '+list(differences));
    for(const note of proposal.pending)lines.push('- '+note);
  }
  lines.push('','配置采用、正式发行与公开部署沿用各自的审批和验收。');
  return {title,body:lines.join('\n')};
}

const branchPrefix = id => 'steward/repository-registration-' + id + '-';

async function matchingPull(api, admin, id, path) {
  const pulls = await api.paginate(api.rest.pulls.list, { ...api.target, state: 'open',
    base: admin.default_branch, per_page: 100 });
  const matches = [];
  for (const pull of pulls) {
    if (pull.head.ref.startsWith(branchPrefix(id))) {
      must(pull.user?.id === stewardBot && pull.head.repo?.id === admin.id,
        'Reserved registration branch belongs to another author');
      matches.push(pull);
      continue;
    }
    const files = await api.paginate(api.rest.pulls.listFiles, { ...api.target, pull_number: pull.number, per_page: 100 });
    if (files.some(file => [file.filename, file.previous_filename].includes(path))) matches.push(pull);
  }
  must(matches.length < 2, 'Multiple open PRs touch this registration');
  return matches[0];
}

export async function reconcileRegistration(api, admin, repo, source, proposal, verifySource) {
  const id = repo.id, path = 'repositories/' + id + '.json';
  const base = await readHead(api, admin.default_branch);
  const read = revisionReader(api, base);
  const merged = await read(path);
  const current = merged === null ? null : parseRegistration(merged, id);
  const differences = fields.filter(key => !current || !isDeepStrictEqual(current[key], proposal.policy[key]));
  const open = await matchingPull(api, admin, id, path);
  if (open) return { result: 'reused', number: open.number, differences, pending: proposal.pending };
  const policy = current ? { ...current, repository: repo.full_name } : proposal.policy;
  if (current && policy.repository === current.repository)
    return { result: differences.length || proposal.pending.length ? 'review-required' : 'unchanged',
      differences, pending: proposal.pending,
      ...(differences.length ? { observations: differences.map(field =>
        ({ field, current: current[field], observed: proposal.policy[field] })) } : {}) };

  const bytes = jsonFile(policy);
  const branch = branchPrefix(id) + digest(bytes).slice(0, 20);
  const args = { ...api.target, base: admin.default_branch, head: 'splrad:' + branch };
  const existing = await api.paginate(api.rest.pulls.list, { ...args, state: 'closed', per_page: 100 });
  if (existing.length) return { result: 'previously-reviewed', number: existing[0].number, differences, pending: proposal.pending };
  must(await verifySource() === source && await readHead(api, admin.default_branch) === base,
    'Registration input moved; refresh the proposal');
  let head = await readHead(api, branch, true);
  if (!head) {
    await api.rest.git.createRef({ ...api.target, ref: 'refs/heads/' + branch, sha: base });
    head = base;
  }
  const {title,body}=renderRegistrationPull(repo,source,proposal,current);
  if (head === base) {
    head = await commitFiles(api, admin, branch, base, new Map([[path, bytes]]), '目标仓源码 ' + source, title);
  } else {
    const { data: commit } = await api.rest.repos.getCommit({ ...api.target, ref: head });
    must(commit.parents.length === 1 && commit.author?.id === stewardBot && commit.committer?.id === webFlow &&
      commit.commit.verification?.verified === true && commit.files?.length === 1 && commit.files[0].filename === path &&
      await revisionReader(api, head)(path) === bytes, 'Recovery branch contains a competing change');
    const parent = commit.parents[0].sha;
    if (parent !== base) {
      const { data: comparison } = await api.rest.repos.compareCommitsWithBasehead({ ...api.target,
        basehead: parent + '...' + base });
      must(comparison.merge_base_commit.sha === parent, 'Recovery branch base is no longer an ancestor');
    }
  }
  must(sha(head) && await readHead(api, branch) === head &&
    await verifySource() === source && await readHead(api, admin.default_branch) === base,
  'Registration input changed before PR creation');
  const concurrent = await matchingPull(api, admin, id, path);
  if (concurrent) return { result: 'reused', number: concurrent.number, differences, pending: proposal.pending };
  const { data: pull } = await api.rest.pulls.create({ ...args, head: branch, title, body, draft: true });
  return { result: 'created', number: pull.number, differences, pending: proposal.pending };
}

async function withStewardAdmin(app, purpose, operation) {
  return app.forRepository(adminId, async token => {
    const api = new Octokit({ ...githubOptions, auth: token });
    const { data } = await api.request('GET /repositories/{id}', { id: adminId });
    const repo = checkRepository(data, adminId);
    must(repo.full_name === 'splrad/steward-settings' && repo.private === true &&
      repo.default_branch === 'main' && !repo.archived && !repo.disabled,
    'Registration administration repository changed');
    api.target = { owner: repo.owner.login, repo: repo.name };
    return operation(api, repo, token);
  }, purpose);
}

async function applyRequests(ids, withGovernance, withAdmin, project) {
  const outcomes = [];
  const errors = [];
  for (const id of ids) {
    try {
      const outcome = await withGovernance(id, { metadata: 'read', contents: 'read' }, async (sourceApi, repo) => {
        if (repo.archived || repo.disabled) return { result: 'inactive' };
        const ref = () => readHead(sourceApi, repo.default_branch, true);
        const source = await ref();
        if (!source) return { result: 'awaiting-default-branch' };
        const read = revisionReader(sourceApi, source);
        let proposal;
        const observe = () => proposal ??= registrationProposal(repo, read);
        const currentSource=async()=>{
          const { data } = await sourceApi.request('GET /repositories/{id}', { id });
          const fresh = checkRepository(data, id);
          if (fresh.archived || fresh.disabled || fresh.full_name !== repo.full_name ||
            fresh.default_branch !== repo.default_branch) return null;
          return ref();
        };
        if(project)await project(repo, source, observe, read, {currentSource});
        const observed=await observe();
        return withAdmin('registration-write', (api, admin) =>
          reconcileRegistration(api, admin, repo, source, observed, currentSource));
        });
      outcomes.push(outcome);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Registration requests incomplete');
  return outcomes;
}

export async function runRegistration(mode, env, {
  withGovernance = (id, permissions, operation) =>
    withScopedApp(env.GOVERNANCE_APP_PRIVATE_KEY, governance, id, permissions, operation),
  openAdmin = async () => {
    const app = await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY ?? '');
    return {
      withAdmin: (purpose, operation) => withStewardAdmin(app, purpose, operation),
      project: (...args) => projectMergedRepositoryPolicy(app, ...args)
    };
  },
  extract,
  output = process.stdout
} = {}) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  if (mode === 'consume') {
    const requestId = readWake(event, env);
    const {withAdmin,project} = await openAdmin();
    const requested = await withAdmin('registration-read', (api, admin, token) =>
      loadPrivateRequest(api, admin, token, requestId, extract));
    const ids=selectRegistrationTargets(requested,env.REGISTRATION_ALLOWED_IDS);
    const result = await applyRequests(ids, withGovernance, withAdmin, project);
    output.write('REGISTRATION_PROCESSED\n');
    return result;
  }

  const ids = env.GITHUB_EVENT_NAME === 'push'
    ? await pushRegistrationIds(event, env, new Octokit({...githubOptions,auth:env.REGISTRATION_ADMIN_TOKEN}))
    : registrationIds(event, env.GITHUB_EVENT_NAME);
  if (mode === 'prepare') {
    if(ids.length===0)return;
    const request = makePrivateRequest(randomUUID(), ids, env);
    await writeFile(env.REGISTRATION_REQUEST_PATH, JSON.stringify(request) + '\n', { flag: 'wx', mode: 0o600 });
    await appendFile(env.GITHUB_OUTPUT, 'id=' + request.requestId + '\n');
    return;
  }

  must(mode === 'notify', 'Invalid registration mode');
  const request = makePrivateRequest(env.REGISTRATION_REQUEST_ID, ids, env);
  const saved = JSON.parse(await readFile(env.REGISTRATION_REQUEST_PATH, 'utf8'));
  must(isDeepStrictEqual(saved, request), 'Registration request changed after upload');
  await withGovernance(centralId, { metadata: 'read', contents: 'write' }, async (api, repo) => {
    must(repo.id === centralId && repo.full_name === 'splrad/steward' && repo.private === false &&
      repo.default_branch === 'main' && !repo.archived && !repo.disabled, 'Invalid registration wake destination');
    await api.rest.repos.createDispatchEvent({ ...api.target, event_type: registrationEvent,
      client_payload: wakePayload(request.requestId) });
  });
}

export async function registrationEntry(mode, env, options = {}) {
  try {
    await runRegistration(mode, env, options);
    return 0;
  } catch {
    (options.errorOutput ?? process.stderr).write('REGISTRATION_UNAVAILABLE\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await registrationEntry(process.argv[2], process.env);
