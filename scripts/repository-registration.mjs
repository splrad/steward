import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { NativeEvidenceReader, nativeEvidenceTransport, nativeReleaseApp, parseDeliveryConfig } from '../packages/runner/dist/index.js';
import contract from '../config/settings-source-events.json' with { type: 'json' };
import { revisionReader } from './configuration-authorization.mjs';
import { commitFiles, must, positive, sha } from './configuration-native.mjs';
import { ciPath, deliveryPath, effectiveChannels, inspectRepository, jsonFile, pagesChoices, pagesPath,
  publishPath, versionsPath } from './configuration-view.mjs';
import { productWorkflows, requiresProductCI, selectableProductCI } from './validation-input.mjs';
import { dependencyMode, loadPolicy } from './private-dependency-policy.mjs';
import { checkedRegistration,configurationConflicts,parseRegistration } from './repository-registration-policy.mjs';
import { projectMergedRepositoryPolicy } from './repository-policy-publish.mjs';
import { readRepositoryProjection } from './repository-policy-projection.mjs';
import { adminId, centralId, isGovernanceBot, loadPrivateRequest, makePrivateRequest, readWake, registrationGitHubOptions,
  registrationEvent, wakePayload } from './repository-registration-request.mjs';

const orgId = 302208797;
const governance = { id: 5639432, installation: 179184801 };
const stewardBot = 301115370;
const webFlow = 19864447;
const fields = ['productCi', 'release', 'site'];
const metadataFiles = ['sbom.spdx.json', 'release-notes.md', 'artifact-manifest.json', 'SHA256SUMS'];
const digest = text => createHash('sha256').update(text).digest('hex');

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
  return [...new Set([...before.keys(),...after.keys()])].filter(id=>before.get(id)!==after.get(id)).sort((a,b)=>a-b);
}

export function selectRegistrationTargets(ids, scope) {
  must(typeof scope==='string'&&scope.length>0,'Registration scope is required');
  const entries=scope.split(',').map(positive);
  const allowed=new Set(entries);
  must(allowed.size===entries.length,'Invalid registration scope');
  return ids.filter(id=>allowed.has(id));
}

function checkRepository(repo, id) {
  must(repo?.id === id && repo.owner?.id === orgId && repo.owner?.login === 'splrad' &&
    repo.full_name === 'splrad/' + repo.name && /^[A-Za-z0-9_.-]+$/.test(repo.name) &&
    typeof repo.default_branch === 'string' && repo.default_branch, 'Repository identity mismatch');
  return repo;
}

async function withScopedApp(key, app, repositoryId, permissions, operation) {
  must(key, 'Registration App credential is unavailable');
  const appApi = new Octokit({ ...registrationGitHubOptions, authStrategy: createAppAuth,
    auth: { appId: app.id, privateKey: key.replace(/\\n/g, '\n') } });
  const { data: installation } = await appApi.request('GET /orgs/{org}/installation', { org: 'splrad' });
  must(installation.id === app.installation && installation.app_id === app.id &&
    installation.account?.id === orgId && !installation.suspended_at, 'Registration installation mismatch');
  const { token } = await appApi.auth({ type: 'installation', installationId: app.installation,
    repositoryIds: [repositoryId], permissions });
  const api = new Octokit({ ...registrationGitHubOptions, auth: token });
  try {
    const { data: scope } = await api.request('GET /installation/repositories', { per_page: 100 });
    must(scope.total_count === 1 && scope.repositories.length === 1 &&
      scope.repositories[0].id === repositoryId, 'Registration token scope mismatch');
    const { data } = await api.request('GET /repositories/{id}', { id: repositoryId });
    const repo = checkRepository(data, repositoryId);
    api.target = { owner: repo.owner.login, repo: repo.name };
    return await operation(api, repo, token);
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

export async function registrationProposal(repo, read, productPaths) {
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
  let productCiApplicable=files.has(ciPath);
  if(productPaths&&!productCiApplicable) {
    const policy=await loadPolicy();
    productCiApplicable=requiresProductCI(productPaths,dependencyMode({repository:repo},policy),
      policy.administrators.find(item=>item.repositoryId===repo.id));
  }
  const productCi = ciPaths.filter(path => model.workflows.some(workflow =>
    workflow.path === path && selectableProductCI(workflow, repo.default_branch)));
  if ((productCiApplicable&&!ciPaths.length)||productCi.length!==ciPaths.length) pending.push('复核产品 CI 工作流或触发条件');
  const priorPending=pending.length;
  const release = releaseRegistration(model, pending);
  const releaseIncomplete=pending.length>priorPending;
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
    productCi, release, site }, repo.id), pending, releaseDetails, productCiApplicable, releaseIncomplete };
}

export function renderRegistrationPull(repo, source, proposal, current=null, policy=current ? {...current,repository:repo.full_name} : proposal.policy) {
  const quote=value=>'`'+String(value).replace(/[`<>\r\n]/g,'')+'`';
  const list=values=>values.map(quote).join('、');
  const path='repositories/'+repo.id+'.json';
  const title='chore: '+(current&&current.repository===repo.full_name?'调整 ':'登记 ')+repo.name+' 逐仓配置';
  const differences=current?fields.filter(key=>!isDeepStrictEqual(current[key],proposal.policy[key])):[];
  const changed=['repository',...fields].filter(key=>!current||!isDeepStrictEqual(current[key],policy[key]));
  const needsReview=differences.length>0||proposal.pending.length>0;
  const lines=[
    '请在这张私有管理员仓 PR 中确认目标仓的治理选择。需要调整时，在 PR 分支编辑 '+quote(path)+
      ' 并提交修改，再从 **Files changed** 核对最终 JSON'+(needsReview?'，并处理下列待确认项':'')+
      '。确认后将草稿转为待审，按本仓流程审查合并。',
    '', '提交调整后，请查看 `SPLRAD Validation` 的逐仓配置复核。公开目标仓会自动核对产品声明。'
      +'需要受信读取或恢复时，可用仓库数字 ID 运行本仓登记工作流。当前发行流程按产品默认分支的已审声明冻结渠道和文件。'
      +'调整发布范围时，先让产品声明体现所需选择。',
    '', '## 仓库与配置', '',
    '- 目标仓 '+quote(repo.full_name)+'（'+repo.id+'）',
    '- 目标仓默认分支提交 '+quote(source),
    '- 配置文件 '+quote(path),
    '- 本次修改 '+list(changed),
    '- 产品 CI '+(list(policy.productCi)||(proposal.productCiApplicable?'待补产品原生 CI 入口':'沿用组织公共检查')),
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
  if(current&&current.repository===repo.full_name) {
    const observations=reviewFields(current,proposal.policy,policy);
    lines.push('',reviewMarker(repo.id,observations,proposal.pending),...registrationReviewLines(observations));
  }
  lines.push('','配置采用、正式发行与公开部署沿用各自的审批和验收。');
  return {title,body:lines.join('\n')};
}

const branchPrefix = id => 'steward/repository-registration-' + id + '-';

async function matchingPull(api, admin, id, path, state='open') {
  const pulls=await api.paginate(api.rest.pulls.list,{...api.target,state,base:admin.default_branch,
    sort:'created',direction:'desc',per_page:100});
  const matches = [];
  for (const pull of pulls) {
    if (pull.head.ref.startsWith(branchPrefix(id))) {
      must(pull.user?.id === stewardBot && pull.head.repo?.id === admin.id,
        'Reserved registration branch belongs to another author');
    } else {
      const files=await api.paginate(api.rest.pulls.listFiles,{...api.target,pull_number:pull.number,per_page:100});
      if(!files.some(file=>[file.filename,file.previous_filename].includes(path)))continue;
    }
    if(state==='closed')return pull;
    matches.push(pull);
  }
  must(matches.length < 2, 'Multiple open PRs touch this registration');
  return matches[0];
}

function proposedRegistration(current, observed) {
  const productCi=current.productCi.length
    ?current.productCi.filter(path=>observed.productCi.includes(path)):observed.productCi;
  const releaseIntent=release=>release&&release.units.map(unit=>({id:unit.id,channels:unit.channels.map(
    ({id,location,required})=>({id,location,required}))}));
  const sameReleaseIntent=isDeepStrictEqual(releaseIntent(current.release),releaseIntent(observed.release));
  const buildOnly=current.site?.mode==='build-only'&&observed.site?.mode==='build-only';
  return {...current,repository:observed.repository,
    productCi:productCi.length?productCi:current.productCi,
    release:sameReleaseIntent?observed.release:current.release,
    site:buildOnly?observed.site:current.site};
}

function reviewFields(current, observed, suggested) {
  return fields.filter(field=>!isDeepStrictEqual(current[field],observed[field])).map(field=>
    ({field,current:current[field],observed:observed[field],suggested:suggested[field]}));
}

function registrationReviewLines(observations) {
  const lines=[];
  for(const {field,current,observed,suggested} of observations) {
    // Indented JSON keeps product values inert in the private message.
    const json=JSON.stringify({'已批准':current,'实际读回':observed,'建议':suggested},null,2).split('\n').map(line=>'    '+line);
    lines.push(`\`${field}\` 已批准值、读回值及建议`,'',...json,'');
  }
  return lines;
}

const reviewPrefix=id=>`<!-- steward-registration-review ${id} `;
const reviewMarker=(id,observations,pending,reviewedHead)=>reviewPrefix(id)+digest(JSON.stringify({observations,pending,reviewedHead}))+' -->';
const conflictDescriptions={
  PRODUCT_CI:'产品 CI 选择必须引用默认分支可运行的入口。已有产品 CI 声明时至少选择一个入口。',
  RELEASE:'当前发行入口按产品默认分支的已审声明冻结正式发行。请先在产品仓调整计划发布的渠道或产物，再使本配置引用相同选择。'
};

async function publishRegistrationReview(api, admin, {id,path,base,source,observations,pending,pull,verifySource,reviewedHead}) {
  must(admin.id===adminId&&admin.full_name==='splrad/steward-settings'&&admin.private===true&&
    admin.default_branch==='main'&&api.target.owner==='splrad'&&api.target.repo==='steward-settings',
  'Invalid registration review destination');
  const marker=reviewMarker(id,observations,pending,reviewedHead);
  const needsReview=observations.length>0||pending.length>0;
  const args={...api.target,issue_number:positive(pull.number)};
  const comments=await api.paginate(api.rest.issues.listComments,{...args,per_page:100});
  const reports=comments.filter(comment=>comment.user?.id===stewardBot&&comment.body?.startsWith(reviewPrefix(id)));
  must(reports.length<=1,'Multiple private registration reviews');
  const prior=reports[0];
  if(prior?.body.startsWith(marker+'\n'))return;
  if(!prior&&(!needsReview||pull.user?.id===stewardBot&&
    pull.body?.split('\n').includes(reviewMarker(id,observations,pending))))return;
  const lines=[marker,`### ${path} ${needsReview?'待确认':'核对完成'}`,'',`产品源码 \`${source}\`。`];
  if(reviewedHead)lines.push(`配置 PR 提交 \`${reviewedHead}\`。`);
  if(needsReview)lines.push(
    `请核对 \`${path}\`。如需采用变动，请更新已有开放配置 PR，或从最新 \`main\` 发起调整 PR。`,
    '',...registrationReviewLines(observations),...pending.map(line=>'- '+line));
  else lines.push(reviewedHead?'当前配置 PR 的选择与产品声明相符。':'当前产品声明与已批准配置相符。');
  const body=lines.join('\n');
  must(await verifySource()===source&&await readHead(api,admin.default_branch)===base,'Registration review source moved');
  if(reviewedHead) {
    const {data:actual}=await api.rest.pulls.get({...api.target,pull_number:positive(pull.number)});
    must(actual.state==='open'&&actual.head?.repo?.id===admin.id&&actual.head.sha===reviewedHead&&
      actual.base?.repo?.id===admin.id&&actual.base.ref===admin.default_branch,'Registration review pull moved');
  }
  if(prior) {
    await api.rest.issues.updateComment({...api.target,comment_id:positive(prior.id),body});
  } else {
    await api.rest.issues.createComment({...args,body});
  }
}

export async function reconcileRegistration(api, admin, repo, source, observe, verifySource, {registryPush=false}={}) {
  const id = repo.id, path = 'repositories/' + id + '.json';
  const base = await readHead(api, admin.default_branch);
  const read = revisionReader(api, base);
  const merged = await read(path);
  const current = merged === null ? null : parseRegistration(merged, id);
  if(!current&&registryPush)return {result:'removed'};
  const proposal=await observe();
  const differences = fields.filter(key => !current || !isDeepStrictEqual(current[key], proposal.policy[key]));
  const renamed=current&&current.repository!==repo.full_name;
  const policy=current?(renamed?{...current,repository:repo.full_name}:proposedRegistration(current,proposal.policy)):proposal.policy;
  const observations=current?reviewFields(current,proposal.policy,policy):[];
  const needsReview=observations.length>0||proposal.pending.length>0;
  const open = await matchingPull(api, admin, id, path);
  const notify=(pull,pending=proposal.pending,reviewedHead)=>publishRegistrationReview(api,admin,
    {id,path,base,source,observations,pending,pull,verifySource,reviewedHead});
  const reviewOpen=async pull=>{
    let reviewedHead;
    const pending=[...proposal.pending];
    if(pull.head.repo?.id===admin.id&&sha(pull.head.sha)) {
      reviewedHead=pull.head.sha;
      const bytes=await revisionReader(api,reviewedHead)(path);
      if(bytes!==null) {
        let selection;
        try { selection=parseRegistration(bytes,id); }
        catch { pending.push('当前草稿的登记 JSON 未通过结构校验，请核对格式和仓库 ID。'); }
        if(selection)for(const conflict of configurationConflicts(selection,proposal))
          pending.push(conflictDescriptions[conflict]);
      }
    }
    if(current||reviewedHead)await notify(pull,pending,reviewedHead);
    return {result:'reused',number:pull.number,differences,pending};
  };
  if(open) {
    return reviewOpen(open);
  }
  if(current&&isDeepStrictEqual(policy,current)) {
    const previous=await matchingPull(api,admin,id,path,'closed');
    if(!needsReview) {
      if(previous)await notify(previous);
      return {result:'unchanged',differences,pending:proposal.pending};
    }
    must(previous,'Missing private configuration pull for registration review');
    await notify(previous);
    return {result:'review-required',number:previous.number,differences,pending:proposal.pending};
  }

  const bytes=jsonFile(checkedRegistration(policy,id));
  const branch = branchPrefix(id) + digest(bytes).slice(0, 20);
  const args = { ...api.target, base: admin.default_branch, head: 'splrad:' + branch };
  const existing = await api.paginate(api.rest.pulls.list, { ...args, state: 'closed', per_page: 100 });
  if(existing.length) {
    must(existing[0].user?.id===stewardBot&&existing[0].head.repo?.id===admin.id,'Reserved registration branch belongs to another author');
    if(current&&needsReview)await notify(existing[0]);
    return {result:'previously-reviewed',number:existing[0].number,differences,pending:proposal.pending};
  }
  must(await verifySource() === source && await readHead(api, admin.default_branch) === base,
    'Registration input moved; refresh the proposal');
  let head = await readHead(api, branch, true);
  if (!head) {
    await api.rest.git.createRef({ ...api.target, ref: 'refs/heads/' + branch, sha: base });
    head = base;
  }
  const {title,body}=renderRegistrationPull(repo,source,proposal,current,policy);
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
  if(concurrent) {
    return reviewOpen(concurrent);
  }
  const { data: pull } = await api.rest.pulls.create({ ...args, head: branch, title, body, draft: true });
  return { result: 'created', number: pull.number, differences, pending: proposal.pending };
}

async function withStewardAdmin(app, purpose, operation) {
  return app.forRepository(adminId, async token => {
    const api = new Octokit({ ...registrationGitHubOptions, auth: token });
    const { data } = await api.request('GET /repositories/{id}', { id: adminId });
    const repo = checkRepository(data, adminId);
    must(repo.full_name === 'splrad/steward-settings' && repo.private === true &&
      repo.default_branch === 'main' && !repo.archived && !repo.disabled,
    'Registration administration repository changed');
    api.target = { owner: repo.owner.login, repo: repo.name };
    return operation(api, repo, token);
  }, purpose);
}

async function applyRequests(ids, withGovernance, withAdmin, project, registryPush) {
  const outcomes = [];
  const errors = [];
  for (const id of ids) {
    try {
      const outcome = await withGovernance(id, { metadata: 'read', contents: 'read' }, async (sourceApi, repo, sourceToken) => {
        if (repo.archived || repo.disabled) return { result: 'inactive' };
        const ref = () => readHead(sourceApi, repo.default_branch, true);
        const source = await ref();
        if (!source) return { result: 'awaiting-default-branch' };
        const read = revisionReader(sourceApi, source);
        let proposal;
        const observe = () => proposal ??= (async()=>{
          const {data:tree}=await sourceApi.rest.git.getTree({...sourceApi.target,tree_sha:source,recursive:'1'});
          return registrationProposal(repo,read,registrationProductPaths(tree));
        })();
        const currentSource=async()=>{
          const { data } = await sourceApi.request('GET /repositories/{id}', { id });
          const fresh = checkRepository(data, id);
          if (fresh.archived || fresh.disabled || fresh.full_name !== repo.full_name ||
            fresh.default_branch !== repo.default_branch) return null;
          return ref();
        };
        const hasResidualProjection=async()=>{
          const reader=new NativeEvidenceReader(nativeEvidenceTransport(sourceToken),repo.full_name);
          const projection=await readRepositoryProjection(reader,id);
          return projection!==null&&projection.adoption!=='legacy';
        };
        let projectionConflict;
        try {
          if(project)await project(repo,source,observe,read,{currentSource,revokeMissing:registryPush,hasResidualProjection});
        } catch(error) {
          if(!['REPOSITORY_POLICY_PROJECTION_PRODUCT_CI','REPOSITORY_POLICY_PROJECTION_PAGES',
            'REPOSITORY_POLICY_PROJECTION_RELEASE'].includes(error.message))throw error;
          projectionConflict=error;
        }
        const result=await withAdmin('registration-write', (api, admin) =>
          reconcileRegistration(api,admin,repo,source,observe,currentSource,{registryPush}));
        if(projectionConflict)throw projectionConflict;
        return result;
      });
      outcomes.push(outcome);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Registration requests incomplete');
  return outcomes;
}

export function registrationProductPaths(tree) {
  must(tree.truncated===false&&Array.isArray(tree.tree),'Incomplete product registration tree');
  return tree.tree.filter(entry=>entry.type!=='tree').map(entry=>entry.path);
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
  markStage = () => {},
  output = process.stdout
} = {}) {
  if (mode === 'consume') markStage('event');
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  if (mode === 'consume') {
    const requestId = readWake(event, env);
    markStage('credential');
    const {withAdmin,project} = await openAdmin();
    const requested = await withAdmin('registration-read', async (api, admin, token) => {
      const request = await loadPrivateRequest(api, admin, token, requestId, extract, markStage);
      markStage('credential');
      return request;
    });
    markStage('apply');
    const ids=selectRegistrationTargets(requested.repositoryIds,env.REGISTRATION_ALLOWED_IDS);
    const result=await applyRequests(ids,withGovernance,withAdmin,project,requested.event==='push');
    output.write('REGISTRATION_PROCESSED\n');
    return result;
  }

  const ids = env.GITHUB_EVENT_NAME === 'push'
    ? await pushRegistrationIds(event, env, new Octokit({...registrationGitHubOptions,auth:env.REGISTRATION_ADMIN_TOKEN}))
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
  let stage;
  try {
    await runRegistration(mode, env, {...options,markStage:value=>{stage=value;}});
    return 0;
  } catch {
    // Stages are fixed source literals. Never expose exception messages from private operations.
    (options.errorOutput ?? process.stderr).write('REGISTRATION_UNAVAILABLE'+(stage?' '+stage:'')+'\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await registrationEntry(process.argv[2], process.env);
