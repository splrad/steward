import {createHash,generateKeyPairSync} from 'node:crypto';
import {expect,it} from 'vitest';
import {BoundedGitHub} from '../src/bounded-recheck-github.js';
import {acceptNativeCandidateEvent} from '../src/bounded-native-event.js';

it('resolves the installed public product and two selected units at trunk without a repository registry',async()=>{
  const id=87234,sha='a'.repeat(40);
  const repo={id,full_name:'splrad/example-release',default_branch:'trunk',private:false,visibility:'public',fork:false,archived:false,disabled:false,owner:{id:302208797}};
  const settings={'separate-pull-requests':false,packages:{cli:{},ui:{}}};
  const files:Record<string,unknown>={'.github/delivery.json':{units:[{id:'cli',path:'cli'},{id:'ui',path:'ui'}]},
    'release-please-config.json':settings,'.release-please-manifest.json':{cli:'1.0.0',ui:'2.0.0'}};
  const records:any[]=[],minted:any[]=[];
  let authorized=true;
  const transport:typeof fetch=async(url,options)=>{
    const u=new URL(String(url));
    if(u.pathname.endsWith('/access_tokens')){
      const grant=JSON.parse(String(options?.body));minted.push(grant);
      expect(grant.repository_ids).toEqual([id]);
      return Response.json({token:'offline-only',permissions:grant.permissions},{status:201});
    }
    if(u.pathname==='/installation/repositories')return Response.json({total_count:authorized?1:2,repositories:[repo]});
    const prefix='/repos/'+repo.full_name+'/';
    expect(u.pathname.startsWith(prefix)).toBe(true);
    const path=u.pathname.slice(prefix.length);
    if(path==='git/ref/heads/trunk')return Response.json({ref:'refs/heads/trunk',object:{type:'commit',sha}});
    if(path==='git/trees/'+sha) {
      const tree=Object.entries(files).map(([path,content])=>{
        const bytes=Buffer.from(JSON.stringify(content));
        return {path,type:'blob',mode:'100644',sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};
      });
      return Response.json({truncated:false,tree});
    }
    expect(u.searchParams.get('ref')).toBe(sha);
    const file=path.slice('contents/'.length);
    if(!Object.hasOwn(files,file))return new Response(null,{status:404});
    const bytes=Buffer.from(JSON.stringify(files[file]));
    return Response.json({path:file,type:'file',size:bytes.length,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),encoding:'base64',content:bytes.toString('base64')});
  };
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const env:any={APP_ID:'4243096',INSTALLATION_ID:'123',STEWARD_APP_PRIVATE_KEY:key,BOUNDED_RECHECK_ENABLED:'true',BOUNDED_CONTROLLER_SHA:sha,
    BOUNDED_DEPLOYMENT_SHA:sha,BOUNDED_RECHECK:{idFromName:(name:string)=>name,get:()=>({fetch:async(req:Request)=>{records.push(await req.json());return Response.json({});}})}};
  const payload={repository:repo,action:'reopened',installation:{id:123},sender:{id:7},pull_request:{number:10,updated_at:'2026-11-19T05:10:00Z'}};
  const receive=()=>acceptNativeCandidateEvent(env,'pull_request',payload,'delivery-1',new BoundedGitHub(env,transport));
  await receive();expect(records[0].hint.repositoryId).toBe(id);
  expect(minted.every(grant=>Object.values(grant.permissions).every(p=>p==='read'))).toBe(true);
  authorized=false;await expect(receive()).rejects.toThrow('CANDIDATE_TOKEN_SCOPE');authorized=true;
  delete files['release-please-config.json'];await receive();
  repo.private=true;await receive();
  expect(records).toHaveLength(1);
});
