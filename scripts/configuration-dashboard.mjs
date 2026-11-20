import {must,openPull,positive} from './configuration-native.mjs';
import {readBotComment} from './configuration-session.mjs';
import {renderConfiguration} from './configuration-view.mjs';

const bot=301115370;
const title='仓库配置';
const checkbox='- [ ] <!-- steward-configure --> 创建或打开配置 PR';
const checked=checkbox.replace('[ ]','[x]');
const marker=id=>'<!-- steward-configuration-dashboard '+id+' -->';
const pullUrl=(repo,number)=>'https://github.com/'+repo.full_name+'/pull/'+positive(number);
const nativePull=(pr,repo)=>pr.user.id===bot && pr.head.repo?.id===repo.id &&
  pr.head.ref.startsWith('steward/repository-configuration-') && pr.base.ref===repo.default_branch;

async function findIssue(api,repo) {
  const issues=await api.paginate(api.rest.issues.listForRepo,{...api.target,state:'all',creator:'splrad-steward[bot]',per_page:100});
  const matches=issues.filter(i=>!i.pull_request && i.user.id===bot && i.user.type==='Bot' &&
    (i.performed_via_github_app==null || i.performed_via_github_app.id===4243096) &&
    (i.title===title || i.body?.startsWith(marker(repo.id)+'\n')));
  must(matches.length<=1,'Multiple official configuration issues');
  return matches[0];
}

async function syncIssue(api,repo,summary,pr) {
  let issue=await findIssue(api,repo);
  const {repository}=await api.graphql('query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){pinnedIssues(first:3){totalCount nodes{issue{number}}}}}',api.target);
  const pins=repository.pinnedIssues;
  const pinned=issue && pins.nodes.some(p=>p.issue.number===issue.number);
  const full=!pinned && pins.totalCount>=3;
  const body=[marker(repo.id),summary,pr?'[打开配置 PR #'+pr.number+']('+pullUrl(repo,pr.number)+')':'当前没有开放的配置 PR。',
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
  return pulls.filter(pr=>nativePull(pr,repo));
}

async function officialComment(api,number,tag) {
  const comments=await api.paginate(api.rest.issues.listComments,{...api.target,issue_number:number,per_page:100});
  const matches=comments.filter(c=>c.user.id===bot && c.body?.startsWith(tag+'\n'));
  must(matches.length<=1,'Ambiguous configuration reply');
  if(!matches.length)return null;
  const body=await readBotComment(api,matches[0]);
  must(body===matches[0].body,'Configuration reply was edited outside the App');
  return matches[0];
}

async function publishComment(api,number,tag,content) {
  const body=tag+'\n\n'+content;
  const old=await officialComment(api,number,tag);
  if(!old)await api.rest.issues.createComment({...api.target,issue_number:number,body});
  else if(old.body!==body)await api.rest.issues.updateComment({...api.target,comment_id:old.id,body});
}

// The caller serializes this transaction per repository in the central workflow.
export async function dashboardRequest({repo,api,issues,write,base,run,data,load,apply}) {
  const event=run.event;
  let requestKey;
  let staleToggle=false;
  const replyTag='<!-- steward-configure-reply '+data.command?.id+' -->';
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
    must(!repo.has_issues && data.command,'Use the official configuration issue');
    const {number,id}=data.command;
    const pr=(await api.rest.pulls.get({...api.target,pull_number:positive(number)})).data;
    must(pr.state==='closed' && nativePull(pr,repo),'Unknown historical configuration PR');
    const comment=(await api.rest.issues.getComment({...api.target,comment_id:positive(id)})).data;
    must(comment.issue_url===pr.issue_url && comment.user.id===run.actor.id && comment.body==='/configure' &&
      comment.created_at===comment.updated_at,'Invalid configuration request comment');
    if(await officialComment(write,number,replyTag))return;
    requestKey='comment-'+id;
  }

  let current=await openPull(api,repo);
  const history=!current || (!repo.has_issues && event==='issue_comment')?await closedPulls(api,repo):[];
  const branch=requestKey && 'steward/repository-configuration-'+base+'-'+requestKey;
  const previous=branch && history.find(pr=>pr.head.ref===branch);
  const model=await load(api,base);
  const summary=renderConfiguration(model,base).replace(/^- \[x\] /gm,'- ☑ ').replace(/^- \[ \] /gm,'- ☐ ');
  const latest=(await api.rest.repos.getBranch({...api.target,branch:repo.default_branch})).data;
  must(latest.commit.sha===base,'Default configuration source moved');
  if(!data.closed && !staleToggle && !previous && !(requestKey && current)) {
    if(event==='schedule' || requestKey) {
      if(!current && (requestKey || !history.length))await apply({branch,draft:true});
    } else await apply({draft:true,firstAdoption:!current && !history.length});
  }
  current=await openPull(api,repo);
  if(repo.has_issues)await syncIssue(issues,repo,summary,current);
  else {
    const surface=current??history[0];
    if(surface)await publishComment(write,surface.number,'<!-- steward-current-configuration -->',
      summary+'\n\n'+(current?'[打开配置 PR #'+current.number+']('+pullUrl(repo,current.number)+')':'管理员可评论 `/configure` 发起新的配置 PR。'));
    if(event==='issue_comment') {
      const result=previous||current;
      must(result,'Missing configuration request result');
      await publishComment(write,data.command.number,replyTag,
        '[配置 PR #'+result.number+']('+pullUrl(repo,result.number)+')');
    }
  }
}
