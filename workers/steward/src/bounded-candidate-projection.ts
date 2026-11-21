import {renderCandidateProjection} from '@splrad/steward-core/candidate-note';
import {verifyGeneratedHead} from './bounded-tree-evidence.js';
import {candidateCommentHeader,formatPreviewBody,previewCommentMatches} from './preview-reference.js';
import {candidateFacts} from './bounded-candidate-evidence.js';
import {exactManual} from './bounded-manual-evidence.js';
import {identityKey} from './bounded-recheck.js';
import {TARGET,digest,ensure,type GitReader} from './bounded-recheck-github.js';
import {APP_BOT_ID} from './bounded-winget-evidence.js';
export function generatedProjectionPreview(session:any,repository:string=TARGET.name){
 ensure(session.generated&&session.identity&&Array.isArray(session.generated.files)&&Array.isArray(session.identity.units),'PROJECTION_CACHE');
 return renderCandidateProjection(session.generated,session.identity,repository);
}
export function generatedStatusBody(facts:any,preview:string,commit:string,repository:string=TARGET.name){
 const id=facts.state.candidate.id;
 const header=candidateCommentHeader(id,facts.pull.head.sha,facts.session.generated.units);
 return formatPreviewBody(header,preview,id,repository,commit);
}
export async function verifyGeneratedProjection(g:GitReader,facts:any,e:any){
 exactManual(e,'bodyDigest,commentId,previewDigest');ensure(!facts.manual&&facts.session.conflict===null,'PROJECTION_PROTECTED');await verifyGeneratedHead(g,facts);const expected=generatedProjectionPreview(facts.session,(g.target??TARGET).name),c=facts.state.candidate;
 ensure(Number.isSafeInteger(e.commentId)&&e.commentId>0&&c.statusCommentId===e.commentId&&facts.session.preview===expected&&e.previewDigest===digest(expected).slice(7),'PROJECTION_STATE');
 const read=(p:string)=>g.json((g.target??TARGET).id,`/repos/${(g.target??TARGET).name}/${p}`);const comments:any[]=[];let complete=false;for(let page=1;page<=5;page++){const batch=await read(`issues/${c.prNumber}/comments?per_page=100&page=${page}`);ensure(Array.isArray(batch),'PROJECTION_COMMENTS');comments.push(...batch);if(batch.length<100){complete=true;break;}}ensure(complete,'PROJECTION_PAGINATION');
 const marker=`<!-- steward:candidate-status:${c.id} -->`,own=comments.filter(x=>typeof x.body==='string'&&x.body.includes(marker));ensure(own.length===1&&own[0].id===e.commentId&&own[0].user?.id===APP_BOT_ID&&own[0].issue_url===`https://api.github.com/repos/${(g.target??TARGET).name}/issues/${c.prNumber}`,'PROJECTION_COMMENT');const body=own[0].body;
 ensure(await previewCommentMatches(g,body,expected,c.id,facts.evidence.stateCommit,
   candidateCommentHeader(c.id,facts.pull.head.sha,facts.session.generated.units))&&digest(body).slice(7)===e.bodyDigest,'PROJECTION_BODY');
 const current=await candidateFacts(g);ensure(identityKey(current.identity)===identityKey(facts.identity)&&Object.entries(facts.evidence).every(([k,v])=>(current.evidence as any)[k]===v),'PROJECTION_MOVED');return current.pull;
}
