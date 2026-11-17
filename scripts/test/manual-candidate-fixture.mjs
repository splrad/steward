import assert from 'node:assert/strict';
import {validateManualCandidate} from '../manual-candidate.mjs';
const H='a'.repeat(40),S='b'.repeat(40),G='c'.repeat(40),id='d'.repeat(64),repo=1187527897;
export function fixture() {
  const producer={repositoryId:1296724484,runId:42,attempt:1,controllerSha:'e'.repeat(40),requestKey:'f'.repeat(64)};
  const unit={id:'layerscape',path:'.',version:'1.0.0',tag:'v1.0.0'};
  const session={repository:{repositoryId:repo,activeCycleId:null,revision:0,candidate:{id,prNumber:192,branch:'steward/release-candidate',
    baseSha:G,publishedHead:G,generatedSnapshotPath:'generated/original.json',pendingWrite:null,statusCommentId:11}},
    generated:{schemaVersion:1,baseSha:G,files:[],units:[unit],configDigest:id,sourceDigest:id},pending:null,identity:{authorsDigest:id,sourceDigest:id,actors:[],contributors:{contributors:[],unresolved:0},units:[]},
    conflict:null,preview:'旧冲突提示',adoption:null};
  const pull={number:192,state:'open',merged:false,labels:[],head:{sha:H,ref:session.repository.candidate.branch,repo:{id:repo}},base:{ref:'main',repo:{id:repo}}};
  const delivery={schemaVersion:1,repositoryAuthors:[{id:7,evidence:'fixture'}],units:[{id:'layerscape',path:'.',notesPath:'.release-notes/layerscape.md',
    assets:[{id:'app',name:'app.zip',mediaType:'application/zip'}],channels:[{id:'ghcr-assets',required:true,location:'ghcr.io/splrad/layerscape'},{id:'winget',required:true,location:'microsoft/winget-pkgs'}]}]};
  const files={'release-please-config.json':JSON.stringify({'include-component-in-tag':false,packages:{'.':{'release-type':'simple','version-file':'VERSION'}}}),
    '.release-please-manifest.json':'{".":"1.0.0"}', '.github/delivery.json':JSON.stringify(delivery),VERSION:'1.0.0\n',
    '.release-notes/layerscape.md':['概述','更新内容','兼容性','升级与迁移','安装说明','已知问题','恢复'].map(h=>`## ${h}\n\n已核对的人工说明。\n`).join('\n')};
  const io={pull:async()=>pull,source:async()=>S,state:async()=>true,isAncestor:async(a,b)=>a===S&&b===H,read:async(head,path)=>{assert.equal(head,H);assert.ok(path in files);return files[path];}};
  const comments=[{id:11,authorId:99,body:`<!-- steward:candidate-status:${id} -->\n旧冲突提示`}],calls=[];
  const project={appBotId:99,now:()=> '2026-11-17T00:00:00Z',verify:()=>validateManualCandidate(session,producer,io),comments:async()=>comments,
    save:async()=>{calls.push('save');return H;},updateComment:async(id,body)=>{calls.push('comment');comments.find(c=>c.id===id).body=body;},
    createComment:async()=>{throw Error('unexpected create');}};
  return {session,producer,unit,pull,delivery,files,io,comments,calls,project};
}
