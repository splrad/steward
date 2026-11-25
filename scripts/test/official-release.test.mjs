import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import YAML from 'yaml';
import {Manifest} from 'release-please';
import { EvidenceReadError } from '../../packages/runner/dist/index.js';
import { finishOfficialAction, approvedOfficialBody, inspectOfficialRelease, inspectPendingOfficialPulls, readBoundOfficialDraft, reconcileOfficialLifecycle } from '../official-release.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const source = 'a'.repeat(40), head = 'b'.repeat(40), newer = 'c'.repeat(40), annotation = 'd'.repeat(40);
const body = '## [1.2.3](https://example.com/version)\n\n修正安装。\n\n<details><summary>贡献者 GitHub ID</summary>\n\n<a href="https://example.com/user"><img src="https://example.com/avatar"></a>\n\n</details>\n\n`Get-Version`';
const pullBody = '请审阅。\n\n---\n\n' + body + '\n\n---\n\n请合并。';
const pending = 'autorelease: pending', tagged = 'autorelease: tagged';
const configPath = 'release-please-config.json', manifestPath = '.release-please-manifest.json';
const approval = {repository:'splrad/Example', repositoryId:10, appBotId:41, defaultBranch:'main', prNumber:18,
  sourceSha:source, unitId:'root', tag:'v1.2.3', version:'1.2.3', releaseId:null, headSha:head,
  pullBodyDigest:digest(pullBody), bodyDigest:digest(body)};

function fixture() {
  const matching = {path:'.', pullRequest:{number:18}, sha:source,
    tag:{toString:()=>approval.tag,version:{toString:()=>approval.version}}, notes:body, draft:true, forceTag:true};
  const pull={number:18,title:'chore(main): release 1.2.3',state:'closed',merged:true,merged_at:'2026-11-23T00:00:00Z',user:{id:41,type:'Bot'},body:pullBody,
    base:{ref:'main',repo:{id:10}},head:{ref:'release-please--branches--main',sha:head,repo:{id:10}},merge_commit_sha:source,labels:[{name:pending}]};
  const config={'separate-pull-requests':true,packages:{'.':{draft:true,'force-tag-creation':true}}};
  const old={id:1,tag_name:'v1.2.2',draft:false};
  const draft={id:2,tag_name:approval.tag,draft:true,immutable:false,author:{id:41},target_commitish:source,body,prerelease:false};
  const facts={pull,config,activeConfig:config,manifest:{'.':'1.2.3'},releases:[old],tag:null,
    scan:[matching],otherTags:[],branch:newer,comparison:'ahead'};
  const file=(path,value)=>{
    const bytes=Buffer.from(JSON.stringify(value));
    return {type:'file',path,encoding:'base64',size:bytes.length,content:bytes.toString('base64'),
      sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};
  };
  const reader={
    async json(path) {
      if (path==='') return {id:10,full_name:approval.repository,default_branch:'main',archived:false,disabled:false};
      if (path==='pulls/18') return structuredClone(facts.pull);
      if (path==='git/ref/heads/main') return {ref:'refs/heads/main',object:{type:'commit',sha:facts.branch}};
      if (path.startsWith('contents/'+configPath+'?ref=')) return file(configPath,path.endsWith(source)?facts.config:facts.activeConfig);
      if (path.startsWith('contents/'+manifestPath+'?ref=')) return file(manifestPath,facts.manifest);
      if (path==='git/ref/tags/v1.2.3') {
        if (!facts.tag) throw new EvidenceReadError(404,null);
        return {ref:'refs/tags/v1.2.3',object:facts.tag};
      }
      if (path==='git/matching-refs/tags') return [...facts.otherTags,
        ...(facts.tag?[{ref:'refs/tags/v1.2.3',object:facts.tag}]:[])];
      if (path==='git/matching-refs/tags/v1.2.3') return [];
      if (path==='git/tags/'+annotation) return {sha:annotation,object:{type:'commit',sha:source}};
      if (path==='releases/2') return structuredClone(facts.releases.find(item=>item.id===2));
      throw Error('Unexpected read '+path);
    },
    async pages(path,field) {
      assert.equal(path,'releases');
      assert.equal(field,'');
      return structuredClone(facts.releases);
    },
  };
  const compare=async()=>({status:facts.comparison,merge_base_commit:{sha:source}});
  const perform=options=>inspectOfficialRelease(approval,{reader,scan:async()=>facts.scan,compare,...options});
  const after=()=>{facts.releases.push(draft);facts.tag={type:'tag',sha:annotation};pull.labels=[{name:tagged}];facts.scan=[];};
  return {facts, matching, draft, perform, after, reader};
}

test('the pinned official parser preserves the approved Chinese body, inline HTML, and code',async()=>{
  assert.equal(await approvedOfficialBody(pullBody),body);
});

test('C4 derives the exact official candidate from the default branch and pending lifecycle',async()=>{
  const title='chore(main): release 1.2.3';
  const merged={number:18,sha:source,title,headBranchName:'release-please--branches--main',
    baseBranchName:'main',labels:[pending],body:pullBody};
  let pulls=[merged,{...merged,number:22,labels:[tagged]}];
  const settings={'separate-pull-requests':true,'include-component-in-tag':false,
    packages:{'.':{'release-type':'simple',draft:true,'force-tag-creation':true}}};
  const github={
    repository:{owner:'splrad',repo:'Example'},
    getFileJson:async path=>path===configPath?settings:{'.':approval.version},
    pullRequestIterator:async function*(branch,state,limit,includeFiles) {
      assert.deepEqual([branch,state,limit,includeFiles],['main','MERGED',200,false]);
      yield* pulls;
    },
  };
  const manifest=await Manifest.fromManifest(github,'main');
  const facts={title,body,tag:approval.tag,prerelease:false};
  const run=()=>inspectPendingOfficialPulls(manifest.findMergedReleasePullRequests(),approval,facts);
  const [release]=await run();
  assert.deepEqual([release.pullRequest.number,release.tag.toString(),release.tag.version.toString(),release.notes,release.sha,release.draft,release.forceTag],
    [18,approval.tag,approval.version,body,source,true,true]);
  pulls=[merged,{...merged,number:23}];
  await assert.rejects(run(),/BRANCH_SCOPE prs=18,23/);
});

test('formats only the verified native draft, preserves reviewed Markdown and resumes a completed edit',async()=>{
  const f=fixture();
  const notes='> [!IMPORTANT]\n>\n> 修改脚本。\n\n## 版本记录\n\n[本版](<https://example.com/v1>)';
  const title='Example v1.2.3';
  const native='## 1.2.3\n-->\n\n'+notes;
  const page='## '+title+'\n\n<!-- release-please\n---\n'+native+'\n\n---\n\n审阅信息';
  f.facts.pull.body=page;
  f.matching.notes=notes;
  const selected={...approval,bodyDigest:digest(notes),pullBodyDigest:digest(page)};
  const compare=async()=>({status:'ahead',merge_base_commit:{sha:source}});
  const previous=await inspectOfficialRelease(selected,{reader:f.reader,compare,scan:async()=>[f.matching]});
  f.after();
  Object.assign(f.draft,{name:'v1.2.3',body:native});
  let writes=0;
  const command=async args=>{
    assert.deepEqual(args,['api','--method','PATCH','repos/splrad/Example/releases/2','-f','name='+title,'-f','body='+notes]);
    Object.assign(f.draft,{name:title,body:notes});
    writes++;
    throw Error('response lost');
  };
  const finish=()=>finishOfficialAction(selected,'fixture',previous,{}, {reader:f.reader,compare,command});
  f.draft.body+=' drift';
  await assert.rejects(finish(),/DRAFT_IDENTITY/);
  f.draft.body=native;
  assert.deepEqual(await finish(),{releaseId:2,body:notes,prerelease:false});
  assert.deepEqual(await finish(),{releaseId:2,body:notes,prerelease:false});
  assert.equal(writes,1);
  assert.deepEqual(await readBoundOfficialDraft({...selected,releaseId:2},f.reader),{releaseId:2,body:notes,prerelease:false});
  f.draft.name='wrong';
  await assert.rejects(finish(),/DRAFT_IDENTITY/);
});

test('only one exact official object can be created; no output is needed to recover its real ID',async()=>{
  const f=fixture(), before=await f.perform();
  assert.equal(before.releaseId,null);
  f.after();
  const observed=await f.perform({previous:before});
  assert.equal(observed.releaseId,2);
  assert.equal(observed.existingTag,source);
  assert.equal(observed.body,body);
  assert.equal(observed.tagged,true);
  await assert.rejects(f.perform({previous:before,output:{id:'3',tag:approval.tag,sha:source}}),/ACTION_OUTPUT/);
  assert.equal((await f.perform()).releaseId,2);
});

test('an empty scan, unrelated pending PR, non-draft, or output flag drift cannot authorize writes',async()=>{
  const f=fixture();
  f.facts.scan=[];
  await assert.rejects(f.perform(),/APPROVED_PULL_MISSING/);
  f.facts.scan=[f.matching,{...f.matching,pullRequest:{number:19}}];
  await assert.rejects(f.perform(),/BRANCH_SCOPE/);
  for (const drift of [{draft:false},{forceTag:false},{sha:newer},{notes:'unexpected'},{prerelease:true}]) {
    f.facts.scan=[{...f.matching,...drift}];
    await assert.rejects(f.perform(),/BRANCH_SCOPE/);
  }
});

test('postmerge edits and config changes are rejected even when the official scan looks identical',async()=>{
  const f=fixture();
  f.facts.pull.body+='\nChanged after merge';
  await assert.rejects(f.perform(),/PULL_BODY_DRIFT/);
  f.facts.pull.body=pullBody;
  f.facts.activeConfig={...f.facts.config,draft:false};
  await assert.rejects(f.perform(),/CONFIG_DRIFT/);
  f.facts.activeConfig=f.facts.config;
  for (const override of [{'label':'custom'}, {'release-label':'custom'}, {'separate-pull-requests':false}]) {
    f.facts.config=f.facts.activeConfig={...f.facts.config,...override};
    await assert.rejects(f.perform(),/ROOT_CONFIG/);
    Object.keys(override).forEach(key=>delete f.facts.config[key]);
    f.facts.config['separate-pull-requests']=true;
  }
});

test('C4 reads the stored merge section and permits edits outside that section',async()=>{
  const f=fixture(), stored={...approval,frozenBody:body};
  const compare=async()=>({status:'ahead',merge_base_commit:{sha:source}});
  const check=()=>inspectOfficialRelease(stored,{reader:f.reader,scan:async()=>f.facts.scan,compare});
  f.facts.pull.body+='\nUpdated footer.';
  assert.equal((await check()).body,body);
  f.facts.pull.body=f.facts.pull.body.replace('修正安装。','变动内容。');
  await assert.rejects(check(),/BODY_DIGEST/);
});

test('draft preparation inherits root defaults and rejects an explicit opt-out or another unit',async()=>{
  const f=fixture();
  const inherited={'separate-pull-requests':true,draft:true,'force-tag-creation':true,packages:{'.':{}}};
  f.facts.config=f.facts.activeConfig=inherited;
  assert.equal((await f.perform()).releaseId,null);
  for (const rejected of [
    {...inherited,packages:{'.':{'force-tag-creation':false}}},
    {...inherited,'skip-github-release':true},
    {...inherited,packages:{'.':{},tools:{}}},
  ]) {
    f.facts.config=f.facts.activeConfig=rejected;
    await assert.rejects(f.perform(),/ROOT_CONFIG/);
  }
});

test('a bound draft resumes from the recorded ID and original body after the default manifest advances',async()=>{
  const f=fixture();f.after();
  f.facts.activeConfig={...f.facts.config,draft:false};
  f.facts.manifest['.']='1.2.4';
  f.facts.pull.body+=' edited later';
  const bound={...approval,releaseId:2};
  assert.deepEqual(await readBoundOfficialDraft(bound,f.reader),{body,prerelease:false,releaseId:2});
  f.draft.body+=' draft drift';
  await assert.rejects(readBoundOfficialDraft(bound,f.reader),/DRAFT_IDENTITY/);
});

test('a correct tag with lost draft creation can continue only through the official action',async()=>{
  const f=fixture(), before=await f.perform();
  f.facts.tag={type:'commit',sha:source};
  await assert.rejects(f.perform({previous:before}),/AFTER_ACTION_DRIFT/);
  assert.equal((await f.perform()).releaseId,null);
  f.facts.tag={type:'commit',sha:newer};
  await assert.rejects(f.perform(),/TAG_SOURCE/);
});

test('release inventory changes between the preflight and postflight stop upload',async()=>{
  const f=fixture(), before=await f.perform();
  f.after();
  f.facts.releases.push({id:3,tag_name:'v9.0.0',draft:true});
  await assert.rejects(f.perform({previous:before}),/AFTER_ACTION_DRIFT/);
  f.facts.releases.pop();
  f.facts.otherTags.push({ref:'refs/tags/v9.0.0',object:{type:'commit',sha:newer}});
  await assert.rejects(f.perform({previous:before}),/AFTER_ACTION_DRIFT/);
  await assert.rejects(f.perform({scopeDigest:before.othersDigest}),/RECORDED_SCOPE_DRIFT/);
  f.facts.otherTags.pop();
  f.facts.releases.push({...f.draft,id:3});
  await assert.rejects(f.perform({previous:before}),/DUPLICATE_OR_REPLACED/);
  f.facts.releases.pop();
  f.draft.body+=' drift';
  await assert.rejects(f.perform({previous:before}),/DRAFT_IDENTITY/);
  f.draft.body=body;
  f.draft.author.id=99;
  await assert.rejects(f.perform({previous:before}),/DRAFT_IDENTITY/);
});

test('the frozen range allows an earlier draft to go public and detects added tags with a frozen body',async()=>{
  const f=fixture();
  f.facts.releases[0].draft=true;
  const before=await f.perform();
  f.facts.releases[0].draft=false;
  const options={scopeDigest:before.othersDigest};
  assert.equal((await f.perform(options)).releaseId,null);
  f.after();
  assert.equal((await f.perform(options)).releaseId,2);
  f.facts.otherTags.push({ref:'refs/tags/v9.0.0',object:{type:'commit',sha:newer}});
  const compare=async()=>({status:'ahead',merge_base_commit:{sha:source}});
  await assert.rejects(inspectOfficialRelease({...approval,frozenBody:body},{reader:f.reader,compare,...options}),/RECORDED_SCOPE_DRIFT/);
});

test('changes observed around the scan are rejected and ordinary descendant commits can continue',async()=>{
  const f=fixture();
  await assert.rejects(f.perform({scan:async()=>{f.facts.pull.labels.push({name:tagged});return [f.matching];}}),/SCAN_DRIFT/);
  f.facts.pull.labels=[{name:pending}];
  assert.equal((await f.perform({scan:async()=>{f.facts.branch='e'.repeat(40);return [f.matching];}})).releaseId,null);
  f.facts.comparison='diverged';
  await assert.rejects(f.perform(),/SOURCE_ANCESTRY/);
});

test('lifecycle recovery clears pending before adding tagged and resolves lost responses on the verified draft',async()=>{
  const facts={pending:true,tagged:false},calls=[];
  const read=async()=>({...facts});
  assert.deepEqual(await reconcileOfficialLifecycle(read,async()=>{
    calls.push('remove pending');facts.pending=false;throw Error('lost response');
  },async()=>{
    assert.equal(facts.pending,false);calls.push('add tagged');facts.tagged=true;throw Error('lost response');
  }),{pending:false,tagged:true});
  assert.deepEqual(calls,['remove pending','add tagged']);
  facts.pending=true;facts.tagged=false;calls.length=0;
  await assert.rejects(reconcileOfficialLifecycle(read,async()=>{throw Error('rejected');},async()=>{calls.push('add tagged');}),/LIFECYCLE_RECOVERY/);
  assert.deepEqual(calls,[]);
});

test('the pinned Action runs only after the gated product and branch checks, in the shared coordinator queue',async()=>{
  const workflow=YAML.parse(await readFile(new URL('../../.github/workflows/release-cycle-event.yml',import.meta.url),'utf8'));
  const lock=await readFile(new URL('../../.github/workflows/actions.lock',import.meta.url),'utf8');
  const steps=workflow.jobs['release-coordinator'].steps;
  const cycleEntries=steps.filter(step=>step.run==='node scripts/release-cycle-event.mjs');
  assert.equal(cycleEntries.length,3);
  for(const step of cycleEntries)assert.equal(step.env.STEWARD_CENTRAL_TOKEN,'${{ github.token }}');
  const position=id=>steps.findIndex(step=>step.id===id);
  assert.ok(position('official_plan')<position('official_token') && position('official_token')<position('official_preflight')
    && position('official_preflight')<position('official_draft'));
  assert.match(steps[position('official_delivery')].if,/vars\.STEWARD_OFFICIAL_RELEASE == 'true'/);
  assert.ok(position('official_delivery')<position('delivery_archive') && position('delivery_archive')<position('official_plan'));
  assert.equal(steps[position('delivery_archive')].with['skip-decompress'],true);
  const action=steps[position('official_draft')];
  assert.match(action.uses,/^googleapis\/release-please-action@[a-f0-9]{40}$/);
  assert.ok(lock.includes(`'${action.uses}'`));
  assert.equal(action.if,"${{ steps.official_preflight.outputs.create == 'true' }}");
  assert.equal(action.with['skip-github-pull-request'],true);
  assert.equal(action.with['release-type'],undefined);
  assert.match(workflow.concurrency.group,/steward-release-coordinator/);
  assert.doesNotMatch(workflow.concurrency.group,/startsWith/);
});
