import {createHash} from 'node:crypto';
import {TagName} from 'release-please/build/src/util/tag-name.js';
import {Version} from 'release-please/build/src/version.js';
import {parseDeliveryConfig,assertProductDelivery,parseSupplementalNotes,manualCandidateFacts,manualCandidatePreview,
  manualCandidateBody,validateManualCandidateRecord} from '../packages/runner/dist/index.js';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const fail=code=>{throw Error(code);};
export function manualManagedEntryMatches(file,entry) {
  if(file.content===null)return entry==='';
  return ['100644','100755'].includes(file.mode)&&entry.startsWith(file.mode+' blob ')
    &&/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry)&&entry.slice(entry.indexOf('\t')+1)===file.path+'\0';
}
/** Read-only proof of an existing manual candidate. No generation or write port is accepted. */
export async function validateManualCandidate(session,producer,io) {
  const c=session.repository.candidate;
  if(session.repository.repositoryId!==1187527897||session.repository.activeCycleId||!c?.prNumber||!session.generated||!session.identity
    ||session.pending||c.pendingWrite||session.generated.units.length!==1)fail('MANUAL_NOT_READY');
  const inspect=async()=>{
    const p=await io.pull(),sourceSha=await io.source();
    if(p.number!==c.prNumber||p.head?.repo?.id!==1187527897||p.base?.repo?.id!==1187527897||p.head.ref!==c.branch
      ||p.base.ref!=='main'||p.state!=='open'||p.merged!==false||!Array.isArray(p.labels)
      ||p.labels.some(l=>l.name==='release:editing')||!await io.state())fail('MANUAL_NATIVE_CHANGED');
    if(!/^[a-f0-9]{40}$/.test(p.head.sha)||!/^[a-f0-9]{40}$/.test(sourceSha))fail('MANUAL_SOURCE');
    return {headSha:p.head.sha,sourceSha};
  };
  const before=await inspect();
  if(!await io.isAncestor(before.sourceSha,before.headSha))fail('MANUAL_SOURCE_NOT_INCLUDED');
  const files=new Map();
  const read=async path=>{const text=await io.read(before.headSha,path);if(typeof text!=='string')fail('MANUAL_FILE');files.set(path,hash(text));return text;};
  const settings=JSON.parse(await read('release-please-config.json')),manifest=JSON.parse(await read('.release-please-manifest.json'));
  const delivery=parseDeliveryConfig(JSON.parse(await read('.github/delivery.json')));assertProductDelivery(delivery,'splrad/LayerScape');
  if(JSON.stringify(Object.keys(settings.packages??{}))!==JSON.stringify(['.'])||JSON.stringify(Object.keys(manifest))!==JSON.stringify(['.']))fail('MANUAL_UNIT_COVERAGE');
  const unit=delivery.units[0],generated=session.generated.units[0],options={...settings,...settings.packages['.']};
  if(unit.id!=='layerscape'||unit.path!=='.'||generated.id!==unit.id||generated.path!==unit.path||manifest['.']!==generated.version
    ||options['release-type']!=='simple'||options['version-file']!=='VERSION')fail('MANUAL_VERSION_ADAPTER');
  if((await read('VERSION')).trim()!==generated.version)fail('MANUAL_VERSION');
  const component=options['include-component-in-tag']===false?undefined:options.component;
  if(options['include-component-in-tag']!==false&&!component)fail('MANUAL_TAG_COMPONENT');
  if(new TagName(Version.parse(generated.version),component,options['tag-separator'],options['include-v-in-tag']).toString()!==generated.tag)fail('MANUAL_TAG');
  // The existing native head identity binds the template; keep the historical five-file record stable.
  const template = await io.read(before.headSha, '.github/release-template.md.mustache');
  parseSupplementalNotes(await read(unit.notesPath), template);
  const allowed=new Set([...session.generated.files.map(file=>file.path),unit.notesPath]);
  const changed=await io.changedPaths(before.sourceSha,before.headSha);
  if(!Array.isArray(changed)||changed.some(path=>typeof path!=='string'||!allowed.has(path)))fail('MANUAL_UNMANAGED_CHANGES');
  // The immutable head binds all bytes; human prose may differ from G, but its file role may not.
  if(!await io.managedStructure(before.headSha,session.generated.files.filter(file=>file.path!==unit.notesPath||file.content!==null)))
    fail('MANUAL_MANAGED_STRUCTURE');
  const result={schemaVersion:1,kind:'validated-manual-candidate',repositoryId:1187527897,candidateId:c.id,prNumber:c.prNumber,
    branch:c.branch,...before,units:[{...generated,notesPath:unit.notesPath}],files:[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,sha256])=>({path,sha256})),
    projection:{preview:manualCandidatePreview(before),bodyDigest:''},producer};
  result.projection.bodyDigest=hash(manualCandidateBody(result));
  await validateManualCandidateRecord(result,1187527897,c.id);
  if(JSON.stringify(await inspect())!==JSON.stringify(before))fail('MANUAL_NATIVE_MOVED');
  // Preserve the original producer and identity on replay, even after projection completed.
  return session.manualValidation&&JSON.stringify(manualCandidateFacts(session.manualValidation))===JSON.stringify(manualCandidateFacts(result))
    ?session.manualValidation:result;
}
/** Only the existing fixed status comment/preview is projected; all facts stay frozen. */
export async function projectManualCandidate(session,cache,io) {
  const candidate=session.repository.candidate,body=manualCandidateBody(cache),marker=`<!-- steward:candidate-status:${cache.candidateId} -->`;
  const verify=async()=>{const now=await io.verify();if(JSON.stringify(manualCandidateFacts(now))!==JSON.stringify(manualCandidateFacts(cache)))fail('MANUAL_FACT_CHANGED');};
  await verify();
  const own=async()=> (await io.comments(candidate.prNumber)).filter(c=>c.authorId===io.appBotId&&c.body.includes(marker));
  let comments=await own();
  if(comments.length>1||candidate.statusCommentId!==null&&(comments.length!==1||comments[0].id!==candidate.statusCommentId))fail('MANUAL_COMMENT_OWNER');
  await verify();
  if(comments[0]) {if(comments[0].body!==body)await io.updateComment(comments[0].id,body);}
  else {try{await io.createComment(candidate.prNumber,body);}catch{/* Unknown writes must reconcile by the fixed native owner. */}}
  comments=await own();if(comments.length!==1||comments[0].body!==body)fail('MANUAL_COMMENT_UNKNOWN');
  await verify();
  if(session.preview!==cache.projection.preview||candidate.statusCommentId!==comments[0].id) {
    session.preview=cache.projection.preview;candidate.statusCommentId=comments[0].id;session.repository.revision++;session.repository.lastProgressAt=io.now();await io.save(session);
  }
  await verify();comments=await own();
  if(comments.length!==1||comments[0].id!==candidate.statusCommentId||comments[0].body!==body)fail('MANUAL_COMMENT_MOVED');
  return {status:'READY',reason:'MANUAL_PROJECTION',head:cache.headSha,
    projectionEvidence:{commentId:comments[0].id,bodyDigest:hash(body),previewDigest:hash(session.preview)}};
}
