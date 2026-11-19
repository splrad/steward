import { sha256Hex } from './fingerprint.js';
import { assertDeliveryPath } from './delivery-config.js';
export interface ManualCandidate {
  schemaVersion: 1 | 2; kind: 'validated-manual-candidate'; repositoryId: number; candidateId: string; prNumber: number;
  branch: string; headSha: string; sourceSha: string;
  units: { id: string; path: string; version: string; tag: string; notesPath: string; versionPath?: string }[];
  files: { path: string; sha256: string }[]; projection: { preview: string; bodyDigest: string };
  producer: { repositoryId: number; runId: number; attempt: number; controllerSha: string; requestKey: string };
}
const exact=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))throw Error('MANUAL_FIELDS');};
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function manualCandidateFacts(v:ManualCandidate) {
  return {kind:v.kind,repositoryId:v.repositoryId,candidateId:v.candidateId,prNumber:v.prNumber,branch:v.branch,
    headSha:v.headSha,sourceSha:v.sourceSha,units:v.units.map(u=>({id:u.id,path:u.path,version:u.version,tag:u.tag,notesPath:u.notesPath,...(u.versionPath?{versionPath:u.versionPath}:{})})),
    files:v.files.map(f=>({path:f.path,sha256:f.sha256})),projection:{preview:v.projection.preview,bodyDigest:v.projection.bodyDigest}};
}
export function manualCandidatePreview(v:Pick<ManualCandidate,'sourceSha'|'headSha'>) {
  return `人工完成稿已核验，保留原文。\n来源：${v.sourceSha}\n候选 head：${v.headSha}\n版本、交付配置及发布说明已按该 head 核对；尚未合并或发行。\n`;
}
export function manualCandidateBody(v:ManualCandidate) {
  return `<!-- steward:candidate-status:${v.candidateId} -->\n候选 head: ${v.headSha}\n${v.units.map(u=>`${u.id}: ${u.version}`).join('\n')}\n\n${v.projection.preview}`;
}
export async function validateManualCandidateRecord(v:any,repositoryId:number,candidateId:string):Promise<void> {
  exact(v,['schemaVersion','kind','repositoryId','candidateId','prNumber','branch','headSha','sourceSha','units','files','projection','producer']);
  if(![1,2].includes(v.schemaVersion)||v.kind!=='validated-manual-candidate'||!Number.isSafeInteger(repositoryId)||repositoryId<1||v.repositoryId!==repositoryId
    ||v.candidateId!==candidateId||!digest(candidateId)||!Number.isSafeInteger(v.prNumber)||v.prNumber<1||typeof v.branch!=='string'||!v.branch
    ||!sha(v.headSha)||!sha(v.sourceSha)||!Array.isArray(v.units)||v.units.length===0)throw Error('MANUAL_OWNER');
  const paths=['.github/delivery.json','.release-please-manifest.json','release-please-config.json'];
  const ids=new Set<string>(), roots=new Set<string>();
  for(const u of v.units) {
    exact(u,['id','path','version','tag','notesPath',...(v.schemaVersion===2?['versionPath']:[])]);
    if(typeof u.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(u.id)||ids.has(u.id)||
        typeof u.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(u.version)||
        typeof u.tag!=='string'||!u.tag)throw Error('MANUAL_UNIT');
    assertDeliveryPath(u.path,{root:true});assertDeliveryPath(u.notesPath);
    if(roots.has(u.path.toLowerCase()))throw Error('MANUAL_UNIT');
    ids.add(u.id);roots.add(u.path.toLowerCase());
    if(v.schemaVersion===1 && (repositoryId!==1187527897||v.units.length!==1||u.id!=='layerscape'||u.path!=='.'))throw Error('MANUAL_UNIT');
    const versionPath=v.schemaVersion===1?'VERSION':u.versionPath;
    assertDeliveryPath(versionPath);
    if(u.path!=='.'&&!versionPath.startsWith(u.path+'/'))throw Error('MANUAL_VERSION_PATH');
    paths.push(versionPath,u.notesPath);
  }
  const expected=paths.sort();
  if(!Array.isArray(v.files)||new Set(expected.map(p=>p.toLowerCase())).size!==expected.length||
      JSON.stringify(v.files.map((f:any)=>f.path))!==JSON.stringify(expected))throw Error('MANUAL_FILES');
  for(const f of v.files){exact(f,['path','sha256']);if(!digest(f.sha256))throw Error('MANUAL_DIGEST');}
  exact(v.projection,['preview','bodyDigest']);
  if(v.projection.preview!==manualCandidatePreview(v)||v.projection.bodyDigest!==await sha256Hex(manualCandidateBody(v)))throw Error('MANUAL_PROJECTION');
  exact(v.producer,['repositoryId','runId','attempt','controllerSha','requestKey']);
  if(v.producer.repositoryId!==1296724484||![v.producer.runId,v.producer.attempt].every(n=>Number.isSafeInteger(n)&&n>0)
    ||!sha(v.producer.controllerSha)||!digest(v.producer.requestKey))throw Error('MANUAL_PRODUCER');
}
