import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {readFile, writeFile, unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export function ticketContext(env) {
  const fields=['GITHUB_REPOSITORY_ID','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_WORKFLOW_SHA'];
  if(fields.some(k=>!env[k]) || !/^[a-f0-9]{40}$/.test(env.GITHUB_WORKFLOW_SHA)) throw Error('TICKET_CONTEXT');
  return JSON.stringify(fields.map(k=>env[k]));
}
function keyBytes(key) { if(!/^[a-f0-9]{64}$/.test(key??'')) throw Error('TICKET_KEY'); return Buffer.from(key,'hex'); }
export function sealTicket(bytes,key,context) {
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyBytes(key),nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return JSON.stringify({version:1,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
}
export function openTicket(envelope,key,context) {
  const value=JSON.parse(envelope);
  if(value.version!==1 || Object.keys(value).sort().join(',')!=='ciphertext,nonce,tag,version') throw Error('TICKET_ENVELOPE');
  const nonce=Buffer.from(value.nonce,'base64'),tag=Buffer.from(value.tag,'base64');
  if(nonce.length!==12 || tag.length!==16) throw Error('TICKET_ENVELOPE');
  const cipher=createDecipheriv('aes-256-gcm',keyBytes(key),nonce);cipher.setAAD(Buffer.from(context));cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(Buffer.from(value.ciphertext,'base64')),cipher.final()]);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [mode,input,output]=process.argv.slice(2);
    if(!['seal','open'].includes(mode)||!input||!output)throw Error('TICKET_ARGUMENTS');
    const key=process.env.GENERATION_TICKET_KEY;delete process.env.GENERATION_TICKET_KEY;
    const bytes=await readFile(input);if(bytes.length>16*1024*1024)throw Error('TICKET_SIZE');
    const context=ticketContext(process.env);
    const result=mode==='seal'?sealTicket(bytes,key,context):openTicket(bytes.toString('utf8'),key,context);
    await writeFile(output,result,{flag:'wx',mode:0o600});
    if(mode==='seal')await unlink(input);
  } catch { console.error('TICKET_ENVELOPE_FAILED');process.exitCode=1; }
}
