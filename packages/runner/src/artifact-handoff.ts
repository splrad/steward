import {open,unlink} from 'node:fs/promises';
import {maxArtifactArchiveBytes} from './artifact-file.js';
import { createHash } from 'node:crypto';
const check=(v:unknown)=>{if(!v)throw new Error('ARTIFACT_HANDOFF_INVALID');};
export function artifactDownloadTimeout(size:number):number {
 check(Number.isSafeInteger(size) && size>0 && size<=maxArtifactArchiveBytes);
 return 60000+Math.ceil(size/(4*1024*1024))*1000;
}
export const archiveDigest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/** Read the signed storage URL without forwarding the API credential. */
export async function downloadArtifactArchive(transport:typeof fetch, token:string, fullName:string, artifactId:number, size:number, expectedDigest:string, destination:string, verify:()=>Promise<void>) {
 const timeout=artifactDownloadTimeout(size);
 const redirect=await transport(`https://api.github.com/repos/${fullName}/actions/artifacts/${artifactId}/zip`,{headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json'},redirect:'manual',signal:AbortSignal.timeout(60000)});
 if(redirect.status!==302)throw new Error('ARTIFACT_DOWNLOAD_HTTP_'+redirect.status);
 const url=new URL(redirect.headers.get('location')??'');check(url.protocol==='https:' && !url.username && !url.password && (url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.githubusercontent.com')));
 const response=await transport(url,{redirect:'error',signal:AbortSignal.timeout(timeout)});
 if(!response.ok)throw new Error('ARTIFACT_DOWNLOAD_HTTP_'+response.status);
 check(response.body);let total=0;
 const file=await open(destination,'wx'),hash=createHash('sha256');
 try {
 const reader=response.body!.getReader();try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;check(total<=size&&total<=maxArtifactArchiveBytes);hash.update(value);{let offset=0;while(offset<value.length){const r=await file.write(value,offset,value.length-offset);check(r.bytesWritten>0);offset+=r.bytesWritten;}}}}finally{try{await reader.cancel();}finally{await file.close();}}
 const digest=hash.digest('hex');check(total===size && 'sha256:'+digest===expectedDigest);await verify();return {path:destination,digest};
 } catch(error) { await unlink(destination); throw error; }
}
