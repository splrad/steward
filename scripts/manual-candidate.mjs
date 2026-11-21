import {createHash} from 'node:crypto';
import {TagName} from 'release-please/build/src/util/tag-name.js';
import {Version} from 'release-please/build/src/version.js';
import {candidateCycleIsSeparate,parseDeliveryConfig,assertProductDelivery,renderCandidateNote,parseSupplementalNotes,assertDeliveryPath,manualCandidateFacts,manualCandidatePreview,
  candidateCommentFits,candidateStatusBody,manualCandidateBody,validateManualCandidateRecord} from '../packages/runner/dist/index.js';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const fail=code=>{throw Error(code);};
export function matchesFrozenUnits(session,snapshot=session.generated) {
  const ids=snapshot.units.map(unit=>unit.id).sort();
  return new Set(ids).size===ids.length&&JSON.stringify(ids)===JSON.stringify(session.identity.units.map(unit=>unit.id).sort());
}
export function manualManagedEntryMatches(file,entry) {
  if(file.content===null)return entry==='';
  return ['100644','100755'].includes(file.mode)&&entry.startsWith(file.mode+' blob ')
    &&/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry)&&entry.slice(entry.indexOf('\t')+1)===file.path+'\0';
}
/** Read-only proof of an existing manual candidate. No generation or write port is accepted. */
export async function validateManualCandidate(session,producer,io) {
  const c=session.repository.candidate;
  const product=io.product;
  if(!product||product.id!==session.repository.repositoryId)fail('MANUAL_OWNER');
  if(!candidateCycleIsSeparate(session.repository,io.activeCycle)||!c?.prNumber||!session.generated||!session.identity
    ||session.pending||c.pendingWrite||!session.generated.units.length)fail('MANUAL_NOT_READY');
  const inspect=async()=>{
    const p=await io.pull(),sourceSha=await io.source();
    if(p.number!==c.prNumber||p.head?.repo?.id!==product.id||p.base?.repo?.id!==product.id||p.head.ref!==c.branch
      ||p.base.ref!==product.defaultBranch||p.state!=='open'||p.merged!==false||!Array.isArray(p.labels)
      ||p.labels.some(l=>l.name==='release:editing')||!await io.state())fail('MANUAL_NATIVE_CHANGED');
    if(!/^[a-f0-9]{40}$/.test(p.head.sha)||!/^[a-f0-9]{40}$/.test(sourceSha))fail('MANUAL_SOURCE');
    return {headSha:p.head.sha,sourceSha};
  };
  const before=await inspect();
  if(!await io.isAncestor(before.sourceSha,before.headSha))fail('MANUAL_SOURCE_NOT_INCLUDED');
  const files=new Map();
  const read=async path=>{const text=await io.read(before.headSha,path);if(typeof text!=='string')fail('MANUAL_FILE');files.set(path,hash(text));return text;};
  const settings=JSON.parse(await read('release-please-config.json')),manifest=JSON.parse(await read('.release-please-manifest.json'));
  const delivery=parseDeliveryConfig(JSON.parse(await read('.github/delivery.json')));assertProductDelivery(delivery);
  const paths=delivery.units.map(unit=>unit.path).sort();
  if(JSON.stringify(Object.keys(settings.packages??{}).sort())!==JSON.stringify(paths)||
     !manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.keys(manifest).some(path=>!paths.includes(path)))fail('MANUAL_UNIT_COVERAGE');
  if(!matchesFrozenUnits(session))fail('MANUAL_UNIT_COVERAGE');
  const template=io.readTemplate?await io.readTemplate(before.headSha):await io.read(before.headSha,'.github/release-template.md.mustache');
  const units=[],notes=new Set(),noteContents=[];
  for(const generated of session.generated.units) {
    const unit=delivery.units.find(unit=>unit.id===generated.id&&unit.path===generated.path);
    if(!unit||manifest[unit.path]!==generated.version)fail('MANUAL_UNIT_COVERAGE');
    const options={...settings,...settings.packages[unit.path]};
    if(options['release-type']!=='simple'||typeof options['version-file']!=='string')fail('MANUAL_VERSION_ADAPTER');
    assertDeliveryPath(options['version-file']);
    const versionPath=unit.path==='.'?options['version-file']:unit.path+'/'+options['version-file'];
    if((await read(versionPath)).trim()!==generated.version)fail('MANUAL_VERSION');
    const component=options['include-component-in-tag']===false?undefined:options.component;
    if(options['include-component-in-tag']!==false&&!component)fail('MANUAL_TAG_COMPONENT');
    if(new TagName(Version.parse(generated.version),component,options['tag-separator'],options['include-v-in-tag']).toString()!==generated.tag)fail('MANUAL_TAG');
    const markdown=await read(unit.notesPath);
    parseSupplementalNotes(markdown,template);noteContents.push(markdown);
    notes.add(unit.notesPath);
    units.push({...generated,notesPath:unit.notesPath,versionPath});
  }
  const legacy=product.id===1187527897&&units.length===1&&units[0].id==='layerscape'&&units[0].path==='.'&&units[0].versionPath==='VERSION';
  const sameBase=before.sourceSha===session.generated.baseSha;
  if(sameBase) {
    if(!c.publishedHead||c.publishedHead===before.headSha||!await io.isAncestor(c.publishedHead,before.headSha))fail('MANUAL_PUBLISHED_ANCESTRY');
    const edits=await io.changedPaths(c.publishedHead,before.headSha);
    if(!edits.length||edits.some(path=>!notes.has(path)))fail('MANUAL_NOTE_SCOPE');
  }
  if(legacy&&!sameBase)delete units[0].versionPath;
  const allowed=new Set([...session.generated.files.map(file=>file.path),...notes]);
  const changed=await io.changedPaths(before.sourceSha,before.headSha);
  if(!Array.isArray(changed)||changed.some(path=>typeof path!=='string'||!allowed.has(path)))fail('MANUAL_UNMANAGED_CHANGES');
  // The immutable head binds all bytes; human prose may differ from G, but its file role may not.
  if(!await io.managedStructure(before.headSha,session.generated.files.filter(file=>!notes.has(file.path)||file.content!==null)))
    fail('MANUAL_MANAGED_STRUCTURE');
  const result={schemaVersion:sameBase?3:legacy?1:2,kind:'validated-manual-candidate',repositoryId:product.id,candidateId:c.id,prNumber:c.prNumber,
    branch:c.branch,...before,units,files:[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,sha256])=>({path,sha256})),
    projection:sameBase?{preview:units.map((unit,i)=>renderCandidateNote(unit.notesPath,noteContents[i],session.identity.units.find(u=>u.id===unit.id).contributors.contributors)).join('\n').replace(/\r\n?/g,'\n'),bodyDigest:''}:{preview:manualCandidatePreview(before),bodyDigest:''},producer};
  result.projection.bodyDigest=hash(manualCandidateBody(result));
  await validateManualCandidateRecord(result,product.id,c.id);
  if(JSON.stringify(await inspect())!==JSON.stringify(before))fail('MANUAL_NATIVE_MOVED');
  // Preserve the original producer and identity on replay, even after projection completed.
  return session.manualValidation&&JSON.stringify(manualCandidateFacts(session.manualValidation))===JSON.stringify(manualCandidateFacts(result))
    ?session.manualValidation:result;
}
/** Only the existing fixed status comment/preview is projected; all facts stay frozen. */
export async function projectManualCandidate(session,cache,io) {
  let body=manualCandidateBody(cache);
  const candidate=session.repository.candidate,marker=`<!-- steward:candidate-status:${cache.candidateId} -->`;
  const verify=async()=>{const now=await io.verify();if(JSON.stringify(manualCandidateFacts(now))!==JSON.stringify(manualCandidateFacts(cache)))fail('MANUAL_FACT_CHANGED');};
  await verify();
  const own=async()=> (await io.comments(candidate.prNumber)).filter(c=>c.authorId===io.appBotId&&c.body.includes(marker));
  let comments=await own();
  if(comments.length>1||candidate.statusCommentId!==null&&(comments.length!==1||comments[0].id!==candidate.statusCommentId))fail('MANUAL_COMMENT_OWNER');
  await verify();
  if(cache.schemaVersion===3&&!candidateCommentFits(body)) {
    const path=`generated/${cache.candidateId}/preview.md`;
    const preview=cache.projection.preview;
    const wrap=commit=>candidateStatusBody(io.repository,cache.candidateId,cache.units,cache.headSha,preview,commit);
    const previous=comments[0]?.body;
    const commit=previous?.match(/\/blob\/([a-f0-9]{40})\/generated\/[a-f0-9]{64}\/preview\.md\)\n$/)?.[1];
    if(commit&&wrap(commit)===previous&&await io.readPreview(commit,path)===preview)body=previous;
    else {
      if(session.preview!==preview) {
        session.preview=preview;session.repository.revision++;session.repository.lastProgressAt=io.now();
      }
      const archive=await io.save(session);
      if(!/^[a-f0-9]{40}$/.test(archive)||await io.readPreview(archive,path)!==preview)fail('MANUAL_PREVIEW_ARCHIVE');
      body=wrap(archive);
    }
    await verify();
  }
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
