import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedBuildEnvironment } from './build-environment.js';
import { qualityBatchInput, validateQualityOutput, type QualitySegment } from '../../core/src/quality-language-summary.js';

export interface QualityModelClient {
  preflight(): Promise<{status:'READY'|'WAIT_AUTH'|'WAIT_QUOTA'; quota?:unknown; models?:string[]}>;
  call(segments:QualitySegment[]): Promise<{items:ReturnType<typeof validateQualityOutput>;model:string;usage:unknown}>;
}
/** Only the installed fixed SDK entry receives a Copilot credential. No App token or inherited profile. */
export function copilotQualityClient(controllerDirectory:string,token:string):QualityModelClient {
  const script = resolve(controllerDirectory,'tools/quality-language/run.mjs');
  async function invoke(mode:'preflight'|'translate',input:string) {
    if (!token.trim() || /[\r\n\0]/.test(token)) throw new Error('WAIT_AUTH');
    const directory = await mkdtemp(join(tmpdir(),'steward-quality-client-'));
    try {
      const environment = isolatedBuildEnvironment(process.env,directory);
      for (const name of ['LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS']) if (process.env[name]) environment[name]=process.env[name];
      const child = spawn(process.execPath,[script,mode],{cwd:directory,windowsHide:true,timeout:160_000,
        env:{...environment,STEWARD_COPILOT_TOKEN:token},stdio:['pipe','pipe','pipe']});
      child.stderr.resume(); child.stdin.on('error',()=>{});
      const chunks:Buffer[]=[];let size=0;
      child.stdout.on('data',(bytes:Buffer)=>{size+=bytes.length;if(size>160*1024)child.kill();else chunks.push(bytes);});
      const code=await new Promise<number|null>((done,reject)=>{child.once('error',()=>reject(new Error('RESPONSE_UNKNOWN')));child.once('close',done);child.stdin.end(input);});
      if(size>160*1024)throw new Error('QUALITY_OUTPUT_LIMIT');
      let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('RESPONSE_UNKNOWN');}
      if(!result || code!==0 || result.status==='FAILED')throw new Error(/^(?:QUALITY_[A-Z_]+|RESPONSE_UNKNOWN)$/.test(result?.errorCode)?result.errorCode:'RESPONSE_UNKNOWN');
      return result;
    } finally { await rm(directory,{recursive:true,force:true}); }
  }
  return {async preflight(){const result=await invoke('preflight','');
    if(!['READY','WAIT_AUTH','WAIT_QUOTA'].includes(result.status))throw new Error('RESPONSE_UNKNOWN');return result;},
  async call(segments){const result=await invoke('translate',qualityBatchInput(segments));
    if(['WAIT_AUTH','WAIT_QUOTA'].includes(result.status))throw Object.assign(new Error(result.status),{retryAfterMs:result.retryAfterMs});
    if(result.status!=='RETURNED' || typeof result.model!=='string' || !result.model.trim())throw new Error('RESPONSE_UNKNOWN');
    return {items:validateQualityOutput(result.value,segments),model:result.model,usage:result.usage};}};
}
