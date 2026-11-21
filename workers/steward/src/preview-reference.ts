import {createHash} from 'node:crypto';
import {TARGET,ensure,type GitReader} from './bounded-recheck-github.js';

const inlineLimit=48*1024;
export function candidateCommentHeader(candidateId:string,head:string,units:{id:string;version:string}[]){
 return `<!-- steward:candidate-status:${candidateId} -->\n候选 head: ${head}\n${units.map(u=>`${u.id}: ${u.version}`).join('\n')}\n\n`;
}
export function formatPreviewBody(header:string,preview:string,id:string,repository:string,commit:string){
 if(Buffer.byteLength(header+preview)<=inlineLimit)return header+preview;
 const linked=`${header}[完整预览](https://github.com/${repository}/blob/${commit}/generated/${id}/preview.md)\n`;
 ensure(Buffer.byteLength(linked)<=inlineLimit,'CANDIDATE_STATUS_HEADER_TOO_LARGE');
 return linked;
}
export async function previewCommentMatches(g:GitReader,body:string,preview:string,id:string,stateCommit:string,header:string){
 if(Buffer.byteLength(header+preview)<=inlineLimit)return body===header+preview;
 const target=g.target??TARGET;
 const match=/\/blob\/([a-f0-9]{40})\/generated\/[a-f0-9]{64}\/preview\.md\)\n$/.exec(body);
 if(!match||body!==formatPreviewBody(header,preview,id,target.name,match[1]!))return false;
 const commit=match[1]!,path=`generated/${id}/preview.md`;
 const read=(suffix:string)=>g.json(target.id,`/repos/${target.name}/${suffix}`);
 const ancestry=await read(`compare/${commit}...${stateCommit}`);
 ensure(ancestry.base_commit?.sha===commit&&ancestry.merge_base_commit?.sha===commit&&['ahead','identical'].includes(ancestry.status),'PROJECTION_LINK_ANCESTRY');
 const tree=await read(`git/trees/${commit}?recursive=1`);
 ensure(tree.truncated===false&&Array.isArray(tree.tree),'PROJECTION_TREE');
 const entries=tree.tree.filter((x:any)=>x.path===path);
 ensure(entries.length===1&&entries[0].type==='blob'&&['100644','100755'].includes(entries[0].mode),'PROJECTION_REGULAR_FILE');
 const f=await read(`contents/${path}?ref=${commit}`);
 ensure(f.path===path&&f.type==='file'&&f.encoding==='base64'&&f.sha===entries[0].sha&&f.size<=512*1024,'PROJECTION_BLOB');
 const bytes=Buffer.from(f.content,'base64');
 ensure(bytes.length===f.size&&createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===f.sha,'PROJECTION_BLOB_CONTENT');
 return bytes.equals(Buffer.from(preview,'utf8'));
}
