import {promotedController} from './bounded-controller.js';
import {PendingPromotion} from './release-promotion.js';
import { BoundedGitHub, CENTRAL, type BoundedEnv, type GitReader } from './bounded-recheck-github.js';
import { dispatchFixed } from './bounded-recheck-effects.js';

const publicRepositories = new Set([1187527897,1296724484,1296725317]);
const qualityUser = 223894421;

export function qualityLocator(event:string, payload:any, installationId:number) {
  const repo=payload.repository;
  if (!repo || !publicRepositories.has(repo.id) || repo.private!==false || repo.owner?.id!==302208797 ||
      repo.archived || repo.disabled || payload.installation?.id!==installationId) return;
  let number:number, head:string;
  if (event==='workflow_run') {
    const run=payload.workflow_run;
    if (payload.action!=='completed' || run?.status!=='completed' || run.conclusion!=='success' ||
        run.repository?.id!==repo.id || run.path!=='dynamic/github-code-quality/codeql' || run.event!=='dynamic') return;
    const match=/^refs\/pull\/([1-9]\d*)\/head$/.exec(run.head_branch);
    if (!match) return;
    number=Number(match[1]);
    head=run.head_sha;
  } else {
    const isReview=event==='pull_request_review' && ['submitted','edited','dismissed'].includes(payload.action);
    const isComment=event==='pull_request_review_comment' && ['created','edited','deleted'].includes(payload.action);
    if (!isReview && !isComment) return;
    const user=(isReview ? payload.review : payload.comment)?.user;
    const pr=payload.pull_request;
    if (user?.id!==qualityUser || user.type!=='Bot' || pr?.base?.repo?.id!==repo.id || pr.state!=='open') return;
    number=pr.number;
    head=pr.head?.sha;
  }
  if (!Number.isSafeInteger(number) || number<=0 || typeof head!=='string' || !/^[0-9a-f]{40}$/.test(head)) return;
  return {repository_id:String(repo.id),pull_number:String(number),head_sha:head};
}

export async function dispatchQualityEvent(env:BoundedEnv,event:string,payload:any,reader?:GitReader) {
  const target=qualityLocator(event,payload,Number(env.INSTALLATION_ID));
  if (!target || env.BOUNDED_RECHECK_ENABLED!=='true' || !env.RELEASE_RELAY_DEPLOYMENT_SHA) return;
  const g=reader??new BoundedGitHub(env);
  let policy:string;
  try{policy=await promotedController(g,env.RELEASE_RELAY_DEPLOYMENT_SHA);}
  catch(error){if(error instanceof PendingPromotion)return;throw error;}
  await dispatchFixed(g,CENTRAL.id,'quality-language-summary.yml',policy,{...target,policy_sha:policy});
}
