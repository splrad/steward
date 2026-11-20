import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardRequest} from '../configuration-dashboard.mjs';
import {inspectRepository} from '../configuration-view.mjs';

const base='a'.repeat(40);
const bot={id:301115370,type:'Bot',login:'splrad-steward[bot]'};
const actor={id:12,type:'User',login:'operator'};
function fixture(enabled=true) {
  const repo={id:42,full_name:'splrad/example',default_branch:'main',has_issues:enabled};
  const issues=[],pins=[],pulls=[],comments=[],writes=[];
  const api={target:{owner:'splrad',repo:'example'},rest:{
    repos:{getBranch:async()=>({data:{commit:{sha:base}}})},
    pulls:{list:'pulls',get:async({pull_number})=>({data:pulls.find(p=>p.number===pull_number)})},
    issues:{
      listForRepo:'issues', listComments:'comments',
      create:async({title,body})=>{
        assert.ok(repo.has_issues);writes.push('issue');
        const issue={number:100,node_id:'I',state:'open',title,body,user:bot};issues.push(issue);return {data:issue};
      },
      update:async({issue_number,state,title,body})=>{
        writes.push('update');Object.assign(issues.find(i=>i.number===issue_number),{state,title,body});
      },
      getComment:async({comment_id})=>({data:comments.find(c=>c.id===comment_id)}),
      createComment:async({issue_number,body})=>{
        writes.push('comment');const id=comments.length+1;
        comments.push({id,node_id:'C'+id,number:issue_number,body,user:bot});
      },
      updateComment:async({comment_id,body})=>{writes.push('edit');comments.find(c=>c.id===comment_id).body=body;}
    }},
    paginate:async(method,params)=>{
      if(method==='pulls')return pulls.filter(p=>p.state===params.state);
      if(method==='issues'){assert.ok(repo.has_issues);return issues;}
      assert.equal(method,'comments');return comments.filter(c=>c.number===params.issue_number);
    },
    graphql:async(query,params)=>{
      if(query.includes('pinnedIssues'))return {repository:{pinnedIssues:{totalCount:pins.length,nodes:pins.map(number=>({issue:{number}}))}}};
      if(query.includes('pinIssue(')){assert.ok(pins.length<3);writes.push('pin');pins.push(100);return {pinIssue:{issue:{isPinned:true}}};}
      const c=comments.find(c=>c.node_id===params.id);
      return {node:{author:{login:bot.login},body:c.body}};
    }};
  const run=(event='schedule',data={},id=10)=>dashboardRequest({repo,api,issues:repo.has_issues?api:null,write:api,base,
    run:{id,event,actor},data,load:async()=>inspectRepository(new Map()),apply:async({branch,draft})=>{
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
  return {run,repo,pins,issues,pulls,comments,writes,click};
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

test('disabled Issues use a historical native PR comment and recover duplicate requests and settings changes',async()=>{
  const f=fixture(false);
  await f.run();assert.equal(f.issues.length,0);assert.equal(f.pulls.length,1);
  const first=f.pulls[0];first.state='closed';await f.run();
  f.comments.push({id:71,user:actor,body:'/configure',issue_url:first.issue_url,created_at:'one',updated_at:'one',number:first.number});
  const request={command:{number:first.number,id:71}};
  await f.run('issue_comment',request);
  assert.equal(f.pulls.length,2);assert.match(f.pulls[0].head.ref,/-comment-71$/);
  assert.match(f.comments.at(-1).body,/pull\/2\)/);
  f.pulls[0].state='closed';await f.run('issue_comment',request);assert.equal(f.pulls.length,2);
  f.repo.has_issues=true;await f.run();assert.equal(f.issues.length,1);assert.deepEqual(f.pins,[100]);
  await assert.rejects(f.run('issue_comment',request),/official configuration issue/);
  f.repo.has_issues=false;await f.run();assert.equal(f.issues.length,1);
});
