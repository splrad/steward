import {mkdtemp,rename,rm} from 'node:fs/promises';
import {join,posix,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileText} from './configuration-authorization.mjs';
import {repositoryPath} from './configuration-build.mjs';
import {client,findEvidence,must,positive,readArchive,sha,trialInventory} from './configuration-native.mjs';
import {inspectRepository} from './configuration-view.mjs';

export async function stageNativeProducer({api,repo,token,source,unit,target,producer,selected,record,directory},archive=readArchive) {
  must(record.sourceSha===source && record.repositoryId===repo.id,'Release record does not match the repository and source');
  must(sha(source) && /^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(producer.workflow),'Invalid frozen source or product workflow');
  const bytes=await fileText(api,producer.workflow,source);
  must(bytes,'Missing product workflow at '+source);
  const units=record.units.filter(u=>u.id===unit);
  must(units.length===1 && selected.length,'Missing release unit or assets');
  const paths=selected.map(file=>{
    const assets=units[0].assets.filter(a=>a.id===file.id);
    must(assets.length===1 && posix.basename(assets[0].name)===assets[0].name,'Invalid selected asset');
    return posix.join(repositoryPath(file.directory,true),repositoryPath(assets[0].name));
  });
  const model=inspectRepository(new Map([[producer.workflow,bytes]]));
  const selection={...producer,unit,target,nativeOnly:true};
  const scratch=await mkdtemp(join(directory,'native-producer-'));
  try {
    let staged;
    const inspect=async(...args)=>{
      staged=join(await mkdtemp(join(scratch,'attempt-')),'selected');
      return trialInventory(...args,(...readArgs)=>archive(...readArgs,{directory:staged,paths}));
    };
    const proof=await findEvidence(api,token,repo,source,source,selection,model,undefined,inspect);
    must(proof,'Complete '+producer.workflow+' / '+(producer.nativeJobName??producer.job)+' at '+source+' and upload '+producer.archive);
    await rename(staged,join(directory,'delivery-files'));
    return proof.binding;
  } finally {await rm(scratch,{recursive:true,force:true});}
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const env=process.env,[owner,name]=env.GITHUB_REPOSITORY.split('/');
  const repo={id:positive(env.GITHUB_REPOSITORY_ID),full_name:env.GITHUB_REPOSITORY,owner:{login:owner},name};
  await stageNativeProducer({api:client(env.GH_TOKEN,repo),repo,token:env.GH_TOKEN,source:env.SOURCE_SHA,
    unit:env.UNIT,target:env.TARGET,producer:JSON.parse(Buffer.from(env.PRODUCER,'base64url')),
    selected:JSON.parse(env.SELECTED_FILES),record:JSON.parse(env.BUILD_RECORD),directory:env.RUNNER_TEMP});
}
