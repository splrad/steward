import {must,openPull,positive,trustedWorkflow} from './configuration-native.mjs';
import {renderConfiguration} from './configuration-view.mjs';
import {authorized,configurationAccess,requestPath} from './configuration-authorization.mjs';

const bot=301115370;
const title='仓库配置';
const checkbox='- [ ] <!-- steward-configure --> 创建或打开配置 PR';
const checked=checkbox.replace('[ ]','[x]');
const marker=id=>'<!-- steward-configuration-dashboard '+id+' -->';
const pullUrl=(repo,number)=>'https://github.com/'+repo.full_name+'/pull/'+positive(number);
const nativePull=(pr,repo)=>pr.user.id===bot && pr.head.repo?.id===repo.id &&
  pr.head.ref.startsWith('steward/repository-configuration-') && pr.base.ref===repo.default_branch;

export async function requestFromComment(api,repo,base,number,id,runId,attempt) {
  // Only the native object locator crosses the webhook boundary. The current base owns all policy and defaults.
  must(await trustedWorkflow(api,requestPath,base,base),'Adopt the dashboard workflow first');
  const {requestAccess}=await configurationAccess(api,base);
  return {run:{id:positive(runId),run_attempt:positive(attempt),event:'issue_comment'},
    data:{command:{number:positive(number),id:positive(id)}},dashboard:true,publicRequests:requestAccess==='public'};
}

async function findIssue(api,repo) {
  const issues=await api.paginate(api.rest.issues.listForRepo,{...api.target,state:'all',creator:'splrad-steward[bot]',per_page:100});
  const matches=issues.filter(i=>!i.pull_request && i.user.id===bot && i.user.type==='Bot' &&
    (i.performed_via_github_app==null || i.performed_via_github_app.id===4243096) &&
    (i.title===title || i.body?.startsWith(marker(repo.id)+'\n')));
  must(matches.length<=1,'Multiple official configuration issues');
  return matches[0];
}

async function syncIssue(api,repo,summary,pr,lastClosed,publicRequests) {
  let issue=await findIssue(api,repo);
  const {repository}=await api.graphql('query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){pinnedIssues(first:3){totalCount nodes{issue{number}}}}}',api.target);
  const pins=repository.pinnedIssues;
  const pinned=issue && pins.nodes.some(p=>p.issue.number===issue.number);
  const full=!pinned && pins.totalCount>=3;
  const body=[marker(repo.id),summary,pr?'[打开配置 PR #'+pr.number+']('+pullUrl(repo,pr.number)+')':'当前没有开放的配置 PR。',
    ...(!pr && lastClosed?['[配置 PR #'+lastClosed.number+']('+pullUrl(repo,lastClosed.number)+')'+
      (lastClosed.merged_at?' 已合并。':' 已关闭，变更未采用。')]:[]),
    publicRequests?'任何用户均可在此评论 `/configure` 请求配置 PR。配置选择由管理员或受托维护者修改。':'管理员或受托维护者可在此评论 `/configure` 请求配置 PR。',
    '机器人会用 👍 确认已处理的评论。如果默认分支连续变化导致本次未能处理，机器人会标记 😕。',
    checkbox,...(full?['本仓的三个置顶位置已占满。']:[])].join('\n\n');
  if(!issue)issue=(await api.rest.issues.create({...api.target,title,body})).data;
  else if(issue.state!=='open' || issue.body!==body || issue.title!==title)
    await api.rest.issues.update({...api.target,issue_number:issue.number,state:'open',title,body});
  if(!pinned && !full) {
    const result=await api.graphql('mutation($id:ID!){pinIssue(input:{issueId:$id}){issue{isPinned}}}',{id:issue.node_id});
    must(result.pinIssue.issue.isPinned,'Configuration issue was not pinned');
  }
  return issue.number;
}

async function closedPulls(api,repo) {
  const pulls=await api.paginate(api.rest.pulls.list,{...api.target,base:repo.default_branch,state:'closed',sort:'created',direction:'desc',per_page:100});
  return pulls.filter(pr=>nativePull(pr,repo)).sort((a,b)=>Date.parse(b.closed_at)-Date.parse(a.closed_at) || b.number-a.number);
}

// The caller serializes this transaction per repository in the central workflow.
export async function dashboardRequest({repo,api,issues,base,run,data,publicRequests,load,apply},retry=true) {
  if(!repo.has_issues)return;
  const event=run.event;
  let requestKey;
  let requester=run.triggering_actor;
  let staleToggle=false;
  if(event==='issues') {
    must(repo.has_issues && data.toggle,'Configuration issue is unavailable');
    const issue=await findIssue(issues,repo);
    const {number,previous,body}=data.toggle;
    must(issue && issue.number===positive(number) && issue.state==='open','Unknown configuration issue');
    must(previous.split('\n').filter(l=>l===checkbox).length===1 && previous.replace(checkbox,checked)===body,'Unexpected configuration issue edit');
    // A retry may arrive after the request has already been acknowledged.
    if(issue.body!==body)return;
    staleToggle=!previous.includes('当前提交 `'+base+'`。');
    requestKey='issue-'+run.id;
  } else if(event==='issue_comment') {
    must(data.command,'Missing configuration request');
    const {number,id}=data.command;
    const issue=await findIssue(issues,repo);
    must(issue && issue.state==='open' && issue.number===positive(number),'Unknown configuration issue');
    const comment=(await issues.rest.issues.getComment({...issues.target,comment_id:positive(id)})).data;
    must(comment.issue_url===issue.url && comment.user.type==='User' && Number.isSafeInteger(comment.user.id) && comment.body==='/configure' &&
      comment.created_at===comment.updated_at,'Invalid configuration request comment');
    requester=comment.user;
    must(publicRequests || await authorized(api,requester,base),'Administrator or configuration delegate required');
    const reactions=await issues.paginate(issues.rest.reactions.listForIssueComment,{...issues.target,comment_id:id,content:'+1',per_page:100});
    if(reactions.some(r=>r.user.id===bot))return;
    requestKey='comment-'+id;
  }

  let current=await openPull(api,repo);
  const history=current?[]:await closedPulls(api,repo);
  const branch=requestKey && 'steward/repository-configuration-'+requestKey;
  const previous=branch && history.find(pr=>pr.head.ref===branch);
  const model=await load(api,base);
  const summary=renderConfiguration(model,base).replace(/^- \[x\] /gm,'- ☑ ').replace(/^- \[ \] /gm,'- ☐ ');
  const latest=(await api.rest.repos.getBranch({...api.target,branch:repo.default_branch})).data;
  if(latest.commit.sha!==base && event==='issue_comment') {
    if(retry) {
      const fresh=await requestFromComment(api,repo,latest.commit.sha,data.command.number,data.command.id,run.id,run.run_attempt);
      return dashboardRequest({repo,api,issues,base:latest.commit.sha,...fresh,load,apply},false);
    }
    await issues.rest.reactions.createForIssueComment({...issues.target,comment_id:data.command.id,content:'confused'});
    return;
  }
  must(latest.commit.sha===base,'Default configuration source moved');
  if(!data.closed && !staleToggle && !previous && !(requestKey && current)) {
    if(event==='schedule' || requestKey) {
      if(!current && (requestKey || !history.length))await apply({base,branch,draft:true,run:{...run,triggering_actor:requester}});
    } else await apply({draft:true,firstAdoption:!current && !history.length});
  }
  current=await openPull(api,repo);
  await syncIssue(issues,repo,summary,current,history[0],publicRequests);
  if(event==='issue_comment')await issues.rest.reactions.createForIssueComment({...issues.target,comment_id:data.command.id,content:'+1'});
}
