import {open} from 'node:fs/promises';
import {maxArtifactArchiveBytes} from './artifact-file.js';
import { createHash } from 'node:crypto';
import type { GitHubClient } from '../../github/src/index.js';
export interface ArtifactBinding { repositoryId:number; fullName:string; workflowPath:string; policySha:string; runId:number; attempt:number; artifactId:number; artifactName:string }
const check=(v:unknown)=>{if(!v)throw new Error('ARTIFACT_HANDOFF_INVALID');};
export function artifactDownloadTimeout(size:number):number {
 check(Number.isSafeInteger(size) && size>0 && size<=maxArtifactArchiveBytes);
 return 60000+Math.ceil(size/(4*1024*1024))*1000;
}
export const archiveDigest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export async function fetchBoundArtifactFile(gh:Pick<GitHubClient,'request'>, transport:typeof fetch, token:string, b:ArtifactBinding,destination:string):Promise<{path:string;digest:string}>{
 check([b.repositoryId,b.runId,b.attempt,b.artifactId].every(v=>Number.isSafeInteger(v)&&v>0) && /^[a-f0-9]{40}$/.test(b.policySha) && /^[\w.-]+\/[\w.-]+$/.test(b.fullName) && /^\.github\/workflows\/[\w-]+\.ya?ml$/.test(b.workflowPath));
 const runPath=`/repos/${b.fullName}/actions/runs/${b.runId}`;
 const verify=async()=>{const r=await gh.request<any>('GET',runPath);check(r.id===b.runId && r.repository?.id===b.repositoryId && r.head_repository?.id===b.repositoryId && r.head_sha===b.policySha && r.path===b.workflowPath && r.event==='workflow_dispatch' && r.run_attempt===b.attempt && r.status==='completed' && r.conclusion==='success');};
 await verify();
 const listing=await gh.request<any>('GET',`/repos/${b.fullName}/actions/runs/${b.runId}/artifacts?per_page=100`);
 check(Number.isSafeInteger(listing.total_count) && listing.total_count<=100 && Array.isArray(listing.artifacts));
 const matches=listing.artifacts.filter((a:any)=>a.name===b.artifactName && !a.expired);check(matches.length===1 && matches[0].id===b.artifactId);
 const a=await gh.request<any>('GET',`/repos/${b.fullName}/actions/artifacts/${b.artifactId}`);
 check(a.id===b.artifactId && a.name===b.artifactName && a.expired===false && a.workflow_run?.id===b.runId && a.workflow_run.head_sha===b.policySha && /^sha256:[a-f0-9]{64}$/.test(a.digest) && Number.isSafeInteger(a.size_in_bytes) && a.size_in_bytes>0 && a.size_in_bytes<=maxArtifactArchiveBytes);
 const redirect=await transport(`https://api.github.com/repos/${b.fullName}/actions/artifacts/${b.artifactId}/zip`,{headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json'},redirect:'manual',signal:AbortSignal.timeout(60000)});
 check(redirect.status===302);const url=new URL(redirect.headers.get('location')??'');check(url.protocol==='https:' && !url.username && !url.password && (url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.githubusercontent.com')));
 const response=await transport(url,{redirect:'error',signal:AbortSignal.timeout(artifactDownloadTimeout(a.size_in_bytes))});check(response.ok && response.body);let total=0;
 const file=await open(destination,'wx'),hash=createHash('sha256');
 const reader=response.body!.getReader();try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;check(total<=a.size_in_bytes&&total<=maxArtifactArchiveBytes);hash.update(value);{let offset=0;while(offset<value.length){const r=await file.write(value,offset,value.length-offset);check(r.bytesWritten>0);offset+=r.bytesWritten;}}}}finally{await reader.cancel();await file?.close();}
 const digest=hash.digest('hex');check(total===a.size_in_bytes && 'sha256:'+digest===a.digest);await verify();return {path:destination,digest};
}
