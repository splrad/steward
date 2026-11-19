import {channelTargetsDigest,verifyChannelProbe,decodeReleaseRecord} from '../packages/runner/dist/index.js';
import {product,sha,sha256} from './bounded-candidate-contract.mjs';
const fail=()=>{throw Error('BOUNDED_WINGET_IDENTITY');};
/** Input is an independently verified protected Git cycle, not a network request body. */
export function boundedWingetInputs(value,executionSha) {
  const cycle=decodeReleaseRecord('cycle',Buffer.from(JSON.stringify(value)));
  if(!sha(executionSha)||cycle.units.length!==1||!cycle.requiredChannels.some(c=>c.unitId===cycle.units[0].id && c.channelId==='winget'))fail();
  const unit=cycle.units[0],targets=[{unitId:unit.id,channelId:'winget',version:unit.version,releaseId:unit.releaseId,manifestDigest:unit.manifestDigest}];
  const digest=channelTargetsDigest({repositoryId:product.id,cycle},targets);
  return {cycle_id:cycle.id,source_sha:cycle.sourceSha,execution_sha:executionSha,controller_sha:cycle.controllerSha,
    targets_json:JSON.stringify(targets),mode:'observe',operation_key:digest,request_key:sha256(JSON.stringify(['observe',digest,executionSha]))};
}
/** Native run/artifact retrieval and original PR provenance remain the caller's responsibility. */
export function verifyBoundedWingetProbe(context,identity,payload,run,job,pull,now) {
  const inputs=boundedWingetInputs(context.cycle,run.headSha),targets=JSON.parse(inputs.targets_json);
  if(context.repositoryId!==product.id||identity.repositoryId!==product.id||identity.cycleId!==context.cycle.id||identity.stage!=='winget-index'
    ||identity.channel!=='winget'||identity.sourceSha!==context.cycle.sourceSha||identity.version!==targets[0].version
    ||identity.artifactDigest!==`sha256:${targets[0].manifestDigest}`||!identity.upstreamPR
    ||pull.number!==identity.upstreamPR.number||pull.node_id!==identity.upstreamPR.nodeId||pull.merged!==true
    ||pull.base?.repo?.full_name!=='microsoft/winget-pkgs'||run.displayTitle!==`Channels observe ${inputs.request_key}`)fail();
  const verified=verifyChannelProbe(context,targets,payload,run,job,now),item=verified.report.items[0];
  return {done:verified.fresh&&item.readStatus==='OK'&&item.exists===true&&item.accepted===true&&item.indexed===true
    &&item.evidenceKind===`github-pr:${pull.number}`,inputs,verified};
}
