import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dashboardRequest} from '../configuration-dashboard.mjs';
import {inspectRepository} from '../configuration-view.mjs';

const base='a'.repeat(40);
const bot={id:301115370,type:'Bot',login:'splrad-steward[bot]'};
const actor={id:12,type:'User',login:'operator'};
function fixture(enabled=true) {
  const repo={id:42,full_name:'splrad/example',default_branch:'main',has_issues:enabled};
  const issues=[],pins=[],pulls=[],comments=[],writes=[],reactions=[],branches=[],sources=[];
  const api={target:{owner:'splrad',repo:'example'},rest:{
    repos:{getBranch:async()=>({data:{commit:{sha:branches.shift()??base}}}),
      getContent:async({path})=>{
        const bytes=path.endsWith('configuration-delegates.json')?Buffer.from('{"requestAccess":"public","delegates":[]}'):await readFile('templates/repository/'+path);
        return {data:{type:'file',encoding:'base64',content:bytes.toString('base64')}};
      }},
    pulls:{list:'pulls',get:async({pull_number})=>({data:pulls.find(p=>p.number===pull_number)})},
    reactions:{listForIssueComment:'reactions',createForIssueComment:async({comment_id})=>reactions.push({comment_id,user:bot})},
    issues:{
      listForRepo:'issues', listComments:'comments',
      create:async({title,body})=>{
        assert.ok(repo.has_issues);writes.push('issue');
        const issue={number:100,node_id:'I',url:'https://api.github.com/repos/splrad/example/issues/100',state:'open',title,body,user:bot};issues.push(issue);return {data:issue};
      },
      update:async({issue_number,state,title,body})=>{
        writes.push('update');Object.assign(issues.find(i=>i.number===issue_number),{state,title,body});
      },
      getComment:async({comment_id})=>({data:comments.find(c=>c.id===comment_id)})
    }},
    paginate:async(method,params)=>{
      if(method==='pulls')return pulls.filter(p=>p.state===params.state);
      if(method==='issues'){assert.ok(repo.has_issues);return issues;}
      if(method==='reactions')return reactions.filter(r=>r.comment_id===params.comment_id);
      assert.equal(method,'comments');return comments.filter(c=>c.number===params.issue_number);
    },
    graphql:async(query,params)=>{
      if(query.includes('pinnedIssues'))return {repository:{pinnedIssues:{totalCount:pins.length,nodes:pins.map(number=>({issue:{number}}))}}};
      if(query.includes('pinIssue(')){assert.ok(pins.length<3);writes.push('pin');pins.push(100);return {pinIssue:{issue:{isPinned:true}}};}
      const c=comments.find(c=>c.node_id===params.id);
      return {node:{author:{login:bot.login},body:c.body}};
    }};
  const run=(event='schedule',data={},id=10)=>dashboardRequest({repo,api,issues:api,base,publicRequests:true,
    run:{id,event,actor,run_attempt:1},data,load:async()=>inspectRepository(new Map()),apply:async({base:source,branch,draft})=>{
      sources.push(source);
      assert.equal(draft,true);
      const number=pulls.length+1;
      pulls.unshift({number,state:'open',issue_url:'https://api.github.com/repos/splrad/example/issues/'+number,
        base:{ref:'main'},head:{repo,ref:branch??'steward/repository-configuration-'+base},user:bot});writes.push('pr');
    }});
  const click=()=>{
    const issue=issues.at(-1),previous=issue.body;
    issue.body=previous.replace('- [ ] <!-- steward-configure','- [x] <!-- steward-configure');
    return {toggle:{number:issue.number,previous,body:issue.body}};
  };
  return {run,repo,pins,issues,pulls,comments,writes,branches,sources,click};
}

test('official issue shows the adopted source, reuses a PR and reopens in place without displacing other pins',async()=>{
  const f=fixture();
  f.pins.push(90,91,92);
  f.issues.push({number:50,title:'仓库配置',user:actor});
  await f.run();
  const issue=f.issues[1];
  assert.match(issue.body,/三个置顶位置已占满/);assert.ok(issue.body.includes(base));
  assert.match(issue.body,/pull\/1\)/);
  const count=f.writes.length;await f.run();assert.equal(f.writes.length,count);
  await f.run('issues',f.click());assert.equal(f.pulls.length,1);
  f.pins.pop();issue.state='closed';
  await f.run();assert.deepEqual(f.pins,[90,91,100]);assert.equal(issue.state,'open');
  f.pulls[0].state='closed';await f.run();assert.match(issue.body,/当前没有开放/);
  const toggle=f.click();await f.run('issues',toggle,22);await f.run('issues',toggle,22);
  assert.equal(f.pulls.length,2);assert.match(issue.body,/pull\/2\)/);
  f.pulls[0].state='closed';await f.run();
  issue.body=issue.body.replace(base,'c'.repeat(40));await f.run('issues',f.click(),23);
  assert.equal(f.pulls.length,2);assert.ok(issue.body.includes(base));
});

test('an exact native comment opens or reuses a PR and cannot edit its configuration',async()=>{
  const f=fixture();
  await f.run();
  f.pulls[0].state='closed';await f.run();
  const issue=f.issues[0];
  f.comments.push({id:71,user:actor,body:'/configure',issue_url:issue.url,created_at:'one',updated_at:'one'});
  const request={command:{number:issue.number,id:71}};
  const advanced='b'.repeat(40);
  f.branches.push(advanced,advanced);
  await f.run('issue_comment',request);
  assert.equal(f.sources.at(-1),advanced);assert.ok(issue.body.includes(advanced));
  assert.equal(f.pulls.length,2);assert.match(f.pulls[0].head.ref,/-comment-71$/);
  await f.run('issue_comment',request);
  assert.equal(f.pulls.length,2);assert.match(issue.body,/pull\/2\)/);
  f.pulls[0].state='closed';await f.run('issue_comment',request);assert.equal(f.pulls.length,2);
  f.comments[0].body='/configure trial';
  await assert.rejects(f.run('issue_comment',request),/Invalid configuration request/);
  await assert.rejects(f.run('issue_comment',{command:{number:99,id:71}}),/Unknown configuration issue/);
});

test('closing a configuration PR refreshes the pinned issue without repeating the request',async()=>{
  const f=fixture();
  await f.run();
  const [issue]=f.issues;
  await f.run('issues',f.click());
  assert.ok(issue.body.includes('- [ ] <!-- steward-configure'));
  const [pr]=f.pulls;
  pr.state='closed';
  pr.closed_at='2026-11-20T02:00:00Z';
  f.pulls.unshift({...pr,number:8,closed_at:'2026-11-20T01:00:00Z',merged_at:'2026-11-20T01:00:00Z'});
  await f.run('pull_request',{closed:true});
  assert.match(issue.body,/配置 PR #1[^\n]+已关闭，变更未采用/);
  assert.equal(issue.state,'open');
  assert.deepEqual(f.pins,[issue.number]);
  const writes=f.writes.length;
  await f.run();
  assert.equal(f.writes.length,writes);
  await f.run('issues',f.click(),23);
  const next=f.pulls[0];
  Object.assign(next,{state:'closed',closed_at:'2026-11-20T03:00:00Z',merged_at:'2026-11-20T03:00:00Z'});
  await f.run('pull_request',{closed:true});
  assert.ok(issue.body.includes('已合并。'));
  assert.ok(!issue.body.includes('变更未采用'));
});
