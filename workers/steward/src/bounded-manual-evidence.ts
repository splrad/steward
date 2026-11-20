import {verifyManualManagedChanges} from './bounded-tree-evidence.js';
import {createHash} from 'node:crypto';
import {assertDeliveryPath} from '../support/core/delivery-config.js';
import {TARGET,CENTRAL,digest,ensure,type GitReader,type ProductTarget} from './bounded-recheck-github.js';
import {APP_BOT_ID} from './bounded-winget-evidence.js';
import type {Identity} from './bounded-recheck.js';
export const exactManual=(v:any,keys:string)=>ensure(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys,'MANUAL_FIELDS');
const hex=(v:unknown,n:number)=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v);
export function manualBody(m:any){return `<!-- steward:candidate-status:${m.candidateId} -->\n候选 head: ${m.headSha}\n${m.units.map((u:any)=>`${u.id}: ${u.version}`).join('\n')}\n\n${m.projection.preview}`;}
export function candidateVersion(units:{id:string;path:string;version:string;tag:string}[]) {
 ensure(Array.isArray(units)&&units.length>0&&new Set(units.map(u=>u.id)).size===units.length&&new Set(units.map(u=>u.path)).size===units.length,'MANUAL_UNIT');
 if(units.length===1)return units[0]!.version;
 const ordered=[...units].sort((a,b)=>a.id<b.id?-1:1);
 return 'units-'+digest(JSON.stringify(ordered.map(({id,path,version,tag})=>[id,path,version,tag]))).slice(7);
}
export function manualIdentity(m:any,state:any,session:any,target:ProductTarget=TARGET):Identity {
 exactManual(m,'branch,candidateId,files,headSha,kind,prNumber,producer,projection,repositoryId,schemaVersion,sourceSha,units');
 const c=state.candidate;
 ensure([1,2].includes(m.schemaVersion)&&m.kind==='validated-manual-candidate'&&m.repositoryId===target.id&&state.repositoryId===target.id&&m.candidateId===c.id&&hex(m.candidateId,64)&&m.prNumber===c.prNumber&&m.branch===c.branch&&hex(m.headSha,40)&&hex(m.sourceSha,40),'MANUAL_OWNER');
 const version=candidateVersion(m.units);
 const expected=['.github/delivery.json','.release-please-manifest.json','release-please-config.json'];
 for(const u of m.units) {
   const legacy=m.schemaVersion===1;
   exactManual(u,legacy?'id,notesPath,path,tag,version':'id,notesPath,path,tag,version,versionPath');
   ensure(!legacy||(m.units.length===1&&m.repositoryId===TARGET.id&&u.id==='layerscape'&&u.path==='.'),'MANUAL_UNIT');
   ensure(typeof u.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(u.id)&&typeof u.version==='string'&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(u.version)&&typeof u.tag==='string'&&u.tag.length>0,'MANUAL_UNIT');
   assertDeliveryPath(u.path,{root:true});assertDeliveryPath(u.notesPath);
   const path=legacy?'VERSION':u.versionPath;assertDeliveryPath(path);
   ensure(u.path==='.'||path.startsWith(u.path+'/'),'MANUAL_VERSION_PATH');expected.push(path,u.notesPath);
 }
 expected.sort();
 ensure(new Set(expected.map(p=>p.toLowerCase())).size===expected.length&&Array.isArray(m.files)&&JSON.stringify(m.files.map((f:any)=>f.path))===JSON.stringify(expected),'MANUAL_FILES');
 for(const f of m.files){exactManual(f,'path,sha256');ensure(hex(f.sha256,64),'MANUAL_DIGEST');}
 exactManual(m.projection,'bodyDigest,preview');const preview=`人工完成稿已核验，保留原文。\n来源：${m.sourceSha}\n候选 head：${m.headSha}\n版本、交付配置及发布说明已按该 head 核对；尚未合并或发行。\n`;
 ensure(m.projection.preview===preview&&m.projection.bodyDigest===digest(manualBody(m)).slice(7),'MANUAL_PROJECTION');
 exactManual(m.producer,'attempt,controllerSha,repositoryId,requestKey,runId');ensure(m.producer.repositoryId===CENTRAL.id&&[m.producer.runId,m.producer.attempt].every(n=>Number.isSafeInteger(n)&&n>0)&&hex(m.producer.controllerSha,40)&&hex(m.producer.requestKey,64),'MANUAL_PRODUCER');
 ensure(session.generated?.units?.length===m.units.length&&m.units.every((u:any,i:number)=>(m.schemaVersion===1?['id','version']:['id','path','tag','version']).every(k=>u[k]===session.generated.units[i][k])),'MANUAL_GENERATED_UNIT');
 const facts={kind:m.kind,repositoryId:m.repositoryId,candidateId:m.candidateId,prNumber:m.prNumber,branch:m.branch,headSha:m.headSha,sourceSha:m.sourceSha,units:m.units.map((u:any)=>({id:u.id,path:u.path,version:u.version,tag:u.tag,notesPath:u.notesPath,...(u.versionPath?{versionPath:u.versionPath}:{})})),files:m.files.map((f:any)=>({path:f.path,sha256:f.sha256})),projection:{preview:m.projection.preview,bodyDigest:m.projection.bodyDigest}};
 const factDigest=digest(JSON.stringify(facts)).slice(7);
 return {repositoryId:target.id,cycleId:m.candidateId,channel:'candidate',version,artifactDigest:'sha256:'+factDigest,sourceSha:m.sourceSha,stage:'candidate',epoch:digest(JSON.stringify([m.kind,m.candidateId,m.headSha,m.sourceSha,factDigest])).slice(7),upstreamPR:null};
}
export async function verifyManualHead(g:GitReader,m:any,pull:any,generatedFiles:any){
 ensure(pull.head.sha===m.headSha,'SOURCE_CHANGED');
 const producer=m.producer,run=await g.json(CENTRAL.id,`/repos/${CENTRAL.name}/actions/runs/${producer.runId}/attempts/${producer.attempt}`);
 ensure(run.id===producer.runId&&run.run_attempt===producer.attempt&&run.repository?.id===CENTRAL.id&&run.head_repository?.id===CENTRAL.id&&run.path==='.github/workflows/release-candidate-event.yml'&&run.head_sha===producer.controllerSha&&run.head_branch==='main'&&run.actor?.id===APP_BOT_ID&&run.event==='workflow_dispatch'&&run.display_title===`Candidate event ${producer.requestKey}`&&run.status==='completed'&&run.conclusion==='success','MANUAL_NATIVE_PRODUCER');
 const read=(p:string)=>g.json((g.target??TARGET).id,`/repos/${(g.target??TARGET).name}/${p}`);
 ensure((await read(`git/ref/heads/${encodeURIComponent((g.target??TARGET).defaultBranch)}`)).object?.sha===m.sourceSha,'SOURCE_CHANGED');
 const ancestry=await read(`compare/${m.sourceSha}...${m.headSha}`);
 ensure(ancestry.base_commit?.sha===m.sourceSha&&ancestry.merge_base_commit?.sha===m.sourceSha&&['ahead','identical'].includes(ancestry.status),'MANUAL_ANCESTRY');
 const tree=await read(`git/trees/${m.headSha}?recursive=1`);ensure(hex(tree.sha,40)&&tree.truncated===false&&Array.isArray(tree.tree),'MANUAL_TREE');await verifyManualManagedChanges(g,m,generatedFiles,tree);
 for(const f of m.files){const entry=tree.tree.filter((e:any)=>e.path===f.path);ensure(entry.length===1&&entry[0].type==='blob'&&['100644','100755'].includes(entry[0].mode),'MANUAL_REGULAR_FILE');const blob=await read(`contents/${f.path.split('/').map(encodeURIComponent).join('/')}?ref=${m.headSha}`);ensure(blob.path===f.path&&blob.sha===entry[0].sha&&blob.type==='file'&&blob.encoding==='base64'&&hex(blob.sha,40)&&blob.size<=512*1024,'MANUAL_BLOB');const b=Buffer.from(blob.content,'base64');ensure(b.length===blob.size&&createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')===blob.sha&&digest(b).slice(7)===f.sha256,'MANUAL_BLOB_DIGEST');const unit=m.units.find((u:any)=>(u.versionPath??'VERSION')===f.path);if(unit)ensure(b.toString('utf8').trim()===unit.version,'MANUAL_VERSION');}
 const p=await read(`pulls/${m.prNumber}`);ensure(p.number===m.prNumber&&p.head?.sha===m.headSha&&p.head?.repo?.id===(g.target??TARGET).id&&p.base?.repo?.id===(g.target??TARGET).id&&p.head.ref===m.branch&&p.base.ref===(g.target??TARGET).defaultBranch&&['open','closed'].includes(p.state)&&typeof p.merged==='boolean'&&Array.isArray(p.labels),'SOURCE_CHANGED');
 ensure((await read(`git/ref/heads/${encodeURIComponent((g.target??TARGET).defaultBranch)}`)).object?.sha===m.sourceSha,'SOURCE_CHANGED');return p;
}
export async function verifyManualProjection(g:GitReader,facts:any,e:any){
 const m=facts.manual;exactManual(e,'bodyDigest,commentId,previewDigest');ensure(Number.isSafeInteger(e.commentId)&&e.commentId>0&&facts.state.candidate.statusCommentId===e.commentId&&facts.session.preview===m.projection.preview&&e.bodyDigest===m.projection.bodyDigest&&e.previewDigest===digest(m.projection.preview).slice(7),'MANUAL_PROJECTION_STATE');
 const comments:any[]=[];let complete=false;for(let page=1;page<=5;page++){const batch=await g.json((g.target??TARGET).id,`/repos/${(g.target??TARGET).name}/issues/${m.prNumber}/comments?per_page=100&page=${page}`);ensure(Array.isArray(batch),'MANUAL_COMMENTS');comments.push(...batch);if(batch.length<100){complete=true;break;}}
 ensure(complete,'MANUAL_COMMENTS_PAGINATION');const marker=`<!-- steward:candidate-status:${m.candidateId} -->`,own=comments.filter(c=>typeof c.body==='string'&&c.body.includes(marker));
 ensure(own.length===1&&own[0].id===e.commentId&&own[0].user?.id===APP_BOT_ID&&own[0].issue_url===`https://api.github.com/repos/${(g.target??TARGET).name}/issues/${m.prNumber}`&&own[0].body===manualBody(m)&&digest(own[0].body).slice(7)===e.bodyDigest,'MANUAL_COMMENT_BINDING');
 const pull=await verifyManualHead(g,m,facts.pull,facts.session.generated.files);
 ensure((await g.json((g.target??TARGET).id,`/repos/${(g.target??TARGET).name}/git/ref/heads/steward/release-state`)).object?.sha===facts.evidence.stateCommit,'STATE_MOVED');return pull;
}

export async function manualProjectionBefore(g:GitReader,facts:any){
 const m=facts.manual,comments:any[]=[];let complete=false;
 for(let page=1;page<=5;page++){const batch=await g.json((g.target??TARGET).id,`/repos/${(g.target??TARGET).name}/issues/${m.prNumber}/comments?per_page=100&page=${page}`);ensure(Array.isArray(batch),'MANUAL_COMMENTS');comments.push(...batch);if(batch.length<100){complete=true;break;}}
 ensure(complete,'MANUAL_COMMENTS_PAGINATION');const marker=`<!-- steward:candidate-status:${m.candidateId} -->`,own=comments.filter(c=>typeof c.body==='string'&&c.body.includes(marker));
 ensure(own.length<=1,'MANUAL_COMMENT_AMBIGUOUS');const c=own[0];if(c)ensure(c.user?.id===APP_BOT_ID&&c.issue_url===`https://api.github.com/repos/${(g.target??TARGET).name}/issues/${m.prNumber}`&&facts.state.candidate.statusCommentId===c.id,'MANUAL_COMMENT_BINDING');else ensure(facts.state.candidate.statusCommentId===null,'MANUAL_COMMENT_MISSING');
 ensure(typeof facts.session.preview==='string','MANUAL_PREVIEW');const before={commentId:c?.id??null,bodyDigest:c?digest(c.body).slice(7):null,previewDigest:digest(facts.session.preview).slice(7)};
 return {before,pending:before.bodyDigest!==m.projection.bodyDigest||facts.session.preview!==m.projection.preview};
}
