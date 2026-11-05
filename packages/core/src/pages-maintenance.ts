import {createHash} from 'node:crypto';
import {decodeBuildJson} from './build-manifest.js';

const check=(ok:unknown,code:string):void=>{if(!ok)throw Error('PAGES_'+code);};
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const exact=(v:any,keys:string[])=>check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),'FIELDS');
const utc=(v:any)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export interface PagesSource {
  schemaVersion:1;repositoryId:number;repository:string;mode:'default-branch'|'release';controllerSha:string;defaultBranch:string;
  sourceSha:string;ref:string;releaseId:number|null;unitId:string|null;manifestDigest:string|null;inputDigest:string;
}
export function validatePagesSource(v:any):PagesSource {
  exact(v,['schemaVersion','repositoryId','repository','mode','controllerSha','defaultBranch','sourceSha','ref','releaseId','unitId','manifestDigest','inputDigest']);
  check(v.schemaVersion===1&&positive(v.repositoryId)&&/^[\w.-]+\/[\w.-]+$/.test(v.repository)
    &&!v.repository.split('/').some((p:string)=>p==='.'||p==='..')&&/^[a-f0-9]{40}$/.test(v.sourceSha)&&/^[a-f0-9]{40}$/.test(v.controllerSha),'IDENTITY');
  check(typeof v.defaultBranch==='string'&&v.defaultBranch.length>0&&typeof v.ref==='string','REF');
  check(v.mode==='default-branch'?v.ref===`refs/heads/${v.defaultBranch}`&&v.releaseId===null&&v.unitId===null&&v.manifestDigest===null
    :v.mode==='release'&&v.ref.startsWith('refs/tags/')&&v.ref.length>10&&positive(v.releaseId)&&/^[a-z][a-z0-9-]*$/.test(v.unitId)&&/^[a-f0-9]{64}$/.test(v.manifestDigest),'MODE');
  check(v.inputDigest===createHash('sha256').update(JSON.stringify([1,v.repositoryId,v.repository,v.mode,v.sourceSha,v.controllerSha,v.ref,v.releaseId,v.unitId,v.manifestDigest])).digest('hex'),'DIGEST');
  return structuredClone(v);
}
interface Request {fromAttempt:number;requestedAt:string;coordinatorRunId:number;coordinatorRunAttempt:number;responseStatus:number|null}
export interface PagesMaintenanceRecord {
  schemaVersion:1;kind:'DISPATCH'|'RUN';repositoryId:number;workflowId:number;source:PagesSource;runId:number|null;
  runAttempt:number;siteDeploymentId:number|null;createdAt:string;observedAt:string;requests:Request[];
}
export function pagesRecordPath(v:PagesMaintenanceRecord):string {
  const dispatch=createHash('sha256').update(JSON.stringify([v.source.inputDigest,v.siteDeploymentId])).digest('hex');
  return `maintenance/pages/${v.kind==='RUN'?v.runId:'dispatch-'+dispatch}.json`;
}
export function decodePagesMaintenance(bytes:Uint8Array,repositoryId:number,path:string):PagesMaintenanceRecord {
  const v=decodeBuildJson(bytes) as PagesMaintenanceRecord;
  exact(v,['schemaVersion','kind','repositoryId','workflowId','source','runId','runAttempt','siteDeploymentId','createdAt','observedAt','requests']);
  validatePagesSource(v.source);
  check(v.schemaVersion===1&&v.repositoryId===repositoryId&&v.source.repositoryId===repositoryId&&positive(v.workflowId),'RECORD_SCOPE');
  check(v.kind==='RUN'?positive(v.runId)&&positive(v.runAttempt):v.kind==='DISPATCH'&&(v.runId===null||positive(v.runId))&&v.runAttempt===0,'RECORD_ID');
  check(v.siteDeploymentId===null||positive(v.siteDeploymentId),'SITE_DEPLOYMENT');
  check(path===pagesRecordPath(v)&&utc(v.createdAt)&&utc(v.observedAt)&&v.createdAt<=v.observedAt,'RECORD_PATH');
  check(Array.isArray(v.requests)&&v.requests.length<=(v.kind==='RUN'?2:3),'REQUEST_LIMIT');
  for(const [i,r] of v.requests.entries()) {
    exact(r,['fromAttempt','requestedAt','coordinatorRunId','coordinatorRunAttempt','responseStatus']);
    check(v.kind==='RUN'?positive(r.fromAttempt)&&r.fromAttempt<=v.runAttempt:r.fromAttempt===0,'REQUEST_ATTEMPT');
    check(utc(r.requestedAt)&&r.requestedAt>=v.createdAt&&r.requestedAt<=v.observedAt&&(!i||r.requestedAt>=v.requests[i-1]!.requestedAt)
      &&positive(r.coordinatorRunId)&&positive(r.coordinatorRunAttempt)&&(r.responseStatus===null||Number.isInteger(r.responseStatus)&&r.responseStatus>=100&&r.responseStatus<=599),'REQUEST');
  }
  return structuredClone(v);
}
export function assertPagesProgress(before:PagesMaintenanceRecord,after:PagesMaintenanceRecord):void {
  for(const key of ['schemaVersion','kind','repositoryId','workflowId','siteDeploymentId','createdAt'] as const)check(before[key]===after[key],'IMMUTABLE_RECORD');
  check(JSON.stringify(before.source)===JSON.stringify(after.source)&&(before.runId===null||before.runId===after.runId),'IMMUTABLE_SOURCE');
  check(after.runAttempt>=before.runAttempt&&after.observedAt>=before.observedAt,'REGRESSION');
  for(const [i,r] of before.requests.entries()) {
    const n=after.requests[i];check(n,'REQUEST_REMOVED');
    check(n!.fromAttempt===r.fromAttempt&&n!.requestedAt===r.requestedAt&&n!.coordinatorRunId===r.coordinatorRunId&&n!.coordinatorRunAttempt===r.coordinatorRunAttempt
      &&(r.responseStatus===null||n!.responseStatus===r.responseStatus),'REQUEST_CHANGED');
  }
}
