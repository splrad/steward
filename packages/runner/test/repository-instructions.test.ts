import {expect,it,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,mkdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {assertRepositoryInstructions} from '../src/repository-instructions.js';
import {main} from '../src/index.js';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';

const expected=()=>readFile('templates/repository/AGENTS.md');
const begin='<!-- BEGIN SPLRAD REPOSITORY REVIEW RULES -->';
const end='<!-- END SPLRAD REPOSITORY REVIEW RULES -->';
const emptySection=`\n${begin}\n\n${end}\n`;
const rulesSection=`\n${begin}\n\n### Steward 发行\n\n- 核对产物来源。\n\n${end}\n`;
// Exercise the adopted format even on the controller-only migration commit.
async function markedTemplate() {
  const template = await expected();
  return template.toString().endsWith(emptySection) ? template : Buffer.concat([template,Buffer.from(emptySection)]);
}

it('accepts empty and populated repository sections without allowing the template to contain rules',async()=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));registerOfflineFixtureRoot(root);
  try {
    execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});
    const bytes=await markedTemplate();
    const publicRules=bytes.toString().slice(0,-emptySection.length);
    const repository=Buffer.from(publicRules+rulesSection);
    const path=join(root,'AGENTS.md'), template=join(root,'templates/repository/AGENTS.md');
    await mkdir(join(template,'..'),{recursive:true});
    await writeFile(template,bytes);
    for(const content of [bytes,repository]){
      await writeFile(path,content);
      await expect(assertRepositoryInstructions(root,bytes,{templateSource:true})).resolves.toBeUndefined();
    }
    await writeFile(template,repository);
    await expect(assertRepositoryInstructions(root,bytes,{templateSource:true})).rejects.toThrow('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION');
    await expect(assertRepositoryInstructions(root,repository,{templateSource:true})).rejects.toThrow('INSTRUCTIONS_TEMPLATE_INVALID');
  } finally { await rm(root,{recursive:true,force:true}); }
});

it('rejects malformed repository sections and requires an exact legacy approval during migration',async()=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));registerOfflineFixtureRoot(root);
  try {
    execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});
    const bytes=await markedTemplate();
    const publicRules=bytes.toString().slice(0,-emptySection.length);
    const path=join(root,'AGENTS.md');
    const malformed=[
      publicRules, publicRules+`\n${begin}\n- Missing end\n`,
      publicRules+`\n${end}\n- Reversed\n${begin}\n`, publicRules+rulesSection+emptySection,
      publicRules+rulesSection+'After end\n', publicRules+emptySection.replace('\n\n'+end,'\n\t\n'+end),
      publicRules+rulesSection.replace(begin,' '+begin), publicRules+'Edited public rules\n'+rulesSection,
    ];
    for(const content of malformed){
      await writeFile(path,content);
      await expect(assertRepositoryInstructions(root,bytes)).rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER');
    }
    await writeFile(path,publicRules);
    const legacy=[{repositoryId:123,sha256:createHash('sha256').update(publicRules).digest('hex')}];
    await expect(assertRepositoryInstructions(root,bytes,{repositoryId:123,legacy})).resolves.toBeUndefined();
    await expect(assertRepositoryInstructions(root,bytes,{repositoryId:124,legacy})).rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER');
    const next=Buffer.from(publicRules+'Reviewed public addition.\n'+emptySection);
    const nextApproval=[{repositoryId:123,sha256:createHash('sha256').update(next).digest('hex')}];
    await writeFile(path,publicRules+'Reviewed public addition.\n'+rulesSection);
    await expect(assertRepositoryInstructions(root,bytes,{repositoryId:123,legacy:nextApproval})).resolves.toBeUndefined();
  } finally { await rm(root,{recursive:true,force:true}); }
});

it('checks the raw committed file in CI even if the working copy has valid bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));registerOfflineFixtureRoot(root);
  try {
    const git=(...args:string[])=>execFileSync('git',args,{cwd:root,windowsHide:true});
    git('init','--quiet');
    git('config','core.autocrlf','false');
    git('config','user.name','Fixture');
    git('config','user.email','fixture@example.invalid');
    const bytes=await markedTemplate(),path=join(root,'AGENTS.md');
    await writeFile(path,Buffer.concat([bytes,Buffer.from('After end\n')]));
    git('add','--','AGENTS.md');
    git('commit','--no-gpg-sign','-qm','Malformed committed rules');
    const head=git('rev-parse','HEAD').toString().trim();
    await writeFile(path,bytes);
    await expect(assertRepositoryInstructions(root,bytes)).resolves.toBeUndefined();
    await expect(assertRepositoryInstructions(root,bytes,{head})).rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER');
  } finally { await rm(root,{recursive:true,force:true}); }
});

it.each(['missing','edited','crlf','bom','no-newline','extra-newline','directory','link','override','copilot','runtime'])('rejects incomplete or competing instruction carrier: %s',async kind=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));registerOfflineFixtureRoot(root);
  try {
    execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});
    const bytes=await expected(),path=join(root,'AGENTS.md');
    if(kind==='directory')await mkdir(path);
    else if(kind==='link')await symlink(root,path,process.platform==='win32'?'junction':'dir');
    else if(kind!=='missing')await writeFile(path,kind==='edited'?Buffer.from('Changed\n'):kind==='crlf'?Buffer.from(bytes.toString().replaceAll('\n','\r\n')):
      kind==='bom'?Buffer.concat([Buffer.from([239,187,191]),bytes]):kind==='no-newline'?bytes.subarray(0,-1):kind==='extra-newline'?Buffer.concat([bytes,Buffer.from('\n')]):bytes);
    if(['override','copilot','runtime'].includes(kind)) {
      const extra=kind==='override'?'AGENTS.override.md':kind==='copilot'?'.github/copilot-instructions.md':'.github/instructions/runtime.instructions.md';
      await mkdir(join(root,'.github/instructions'),{recursive:true});await writeFile(join(root,extra),'Human text\n');
    }
    await expect(assertRepositoryInstructions(root,bytes)).rejects.toThrow('INSTRUCTIONS_');
    if(kind==='runtime')expect(await readFile(join(root,'.github/instructions/runtime.instructions.md'),'utf8')).toBe('Human text\n');
  }finally{await rm(root,{recursive:true,force:true});}
});
it.each(['src/AGENTS.md','docs/AGENTS.override.md','.github/instructions/security.instructions.md','sub/.github/copilot-instructions.md'])('finds instruction carriers anywhere in the Git tree: %s',async path=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));registerOfflineFixtureRoot(root);
  try{
    execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});
    const bytes=await expected();await writeFile(join(root,'AGENTS.md'),bytes);
    await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),'Retain human content\n');
    execFileSync('git',['add','--',path],{cwd:root,windowsHide:true});
    await expect(assertRepositoryInstructions(root,bytes)).rejects.toThrow('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION');
    expect(await readFile(join(root,path),'utf8')).toBe('Retain human content\n');
  }finally{await rm(root,{recursive:true,force:true});}
});
it('accepts only the trusted repository and exact old bytes, then rejects them when compatibility closes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));registerOfflineFixtureRoot(root);
  try{
    execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});
    const bytes=await expected(),old=Buffer.from('## Code Review Rules\n\nPrevious approved rules\n');
    const legacy=[{repositoryId:123,sha256:createHash('sha256').update(old).digest('hex')}];
    await writeFile(join(root,'AGENTS.md'),old);
    await expect(assertRepositoryInstructions(root,bytes,{repositoryId:123,legacy})).resolves.toBeUndefined();
    await expect(assertRepositoryInstructions(root,bytes,{legacy})).rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER');
    await expect(assertRepositoryInstructions(root,bytes,{repositoryId:124,legacy})).rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER');
    await expect(assertRepositoryInstructions(root,bytes,{repositoryId:123,legacy:[]})).rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER');
    await writeFile(join(root,'AGENTS.md'),Buffer.concat([old,Buffer.from('edited\n')]));
    await expect(assertRepositoryInstructions(root,bytes,{repositoryId:123,legacy})).rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER');
    await writeFile(join(root,'AGENTS.md'),bytes);
    await expect(assertRepositoryInstructions(root,bytes,{repositoryId:124,legacy})).resolves.toBeUndefined();
  }finally{await rm(root,{recursive:true,force:true});}
});
it('keeps formatting and extra-carrier rejection during exact legacy compatibility',async()=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));registerOfflineFixtureRoot(root);
  try{
    execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});const bytes=await expected();
    const invalid=Buffer.from('## Code Review Rules\r\n');await writeFile(join(root,'AGENTS.md'),invalid);
    await expect(assertRepositoryInstructions(root,bytes,{repositoryId:123,legacy:[{repositoryId:123,sha256:createHash('sha256').update(invalid).digest('hex')}]})).rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER');
    await writeFile(join(root,'AGENTS.md'),bytes);await mkdir(join(root,'nested'));await writeFile(join(root,'nested/AGENTS.md'),bytes);
    execFileSync('git',['add','--','nested/AGENTS.md'],{cwd:root,windowsHide:true});
    await expect(assertRepositoryInstructions(root,bytes,{repositoryId:123,legacy:[{repositoryId:123,sha256:createHash('sha256').update(bytes).digest('hex')}]})).rejects.toThrow('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION');
  }finally{await rm(root,{recursive:true,force:true});}
});
it('allows only the trusted central template source and compares its complete bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));registerOfflineFixtureRoot(root);
  try{
    execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});const bytes=await expected();
    await writeFile(join(root,'AGENTS.md'),bytes);await mkdir(join(root,'templates/repository'),{recursive:true});await writeFile(join(root,'templates/repository/AGENTS.md'),bytes);
    execFileSync('git',['add','--','templates/repository/AGENTS.md'],{cwd:root,windowsHide:true});
    await expect(assertRepositoryInstructions(root,bytes)).rejects.toThrow('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION');
    await expect(assertRepositoryInstructions(root,bytes,{templateSource:true})).resolves.toBeUndefined();
    await writeFile(join(root,'templates/repository/AGENTS.md'),'Candidate supplied template\n');
    await expect(assertRepositoryInstructions(root,bytes,{templateSource:true})).rejects.toThrow('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION');
  }finally{await rm(root,{recursive:true,force:true});}
});
it('requires the central template in the reviewed commit',async()=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));registerOfflineFixtureRoot(root);
  try{
    const git=(...args:string[])=>execFileSync('git',args,{cwd:root,windowsHide:true});
    git('init','--quiet');
    git('config','core.autocrlf','false');
    git('config','user.name','Fixture');
    git('config','user.email','fixture@example.invalid');
    const bytes=await expected(),template='templates/repository/AGENTS.md';
    await writeFile(join(root,'AGENTS.md'),bytes);
    await mkdir(join(root,template,'..'),{recursive:true});
    await writeFile(join(root,template),bytes);
    git('add','--','AGENTS.md',template);
    git('commit','--no-gpg-sign','-qm','Include the central template');
    const present=git('rev-parse','HEAD').toString().trim();
    await expect(assertRepositoryInstructions(root,bytes,{templateSource:true,head:present})).resolves.toBeUndefined();
    git('rm','--quiet','--',template);
    git('commit','--no-gpg-sign','-qm','Remove the central template');
    const missing=git('rev-parse','HEAD').toString().trim();
    await expect(assertRepositoryInstructions(root,bytes,{head:missing})).resolves.toBeUndefined();
    await expect(assertRepositoryInstructions(root,bytes,{templateSource:true,head:missing}))
      .rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER: '+template);
  }finally{await rm(root,{recursive:true,force:true});}
});
it('admits the next central template only through the earlier trusted repository/digest transition',async()=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));registerOfflineFixtureRoot(root);
  try{
    execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});
    const current=await expected(),next=Buffer.from('## Code Review Rules\n\nNext separately approved template\n');
    const legacy=[{repositoryId:123,sha256:createHash('sha256').update(next).digest('hex')}];
    await writeFile(join(root,'AGENTS.md'),next);await mkdir(join(root,'templates/repository'),{recursive:true});
    const template=join(root,'templates/repository/AGENTS.md');await writeFile(template,next);
    execFileSync('git',['add','--','AGENTS.md','templates/repository/AGENTS.md'],{cwd:root,windowsHide:true});
    // The earlier trusted validator still has current bytes while reviewing the
    // approved next template. The candidate cannot authorize its own digest.
    await expect(assertRepositoryInstructions(root,current,{repositoryId:123,legacy,templateSource:true})).resolves.toBeUndefined();
    await expect(assertRepositoryInstructions(root,current,{repositoryId:124,legacy,templateSource:true})).rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER');
    await expect(assertRepositoryInstructions(root,current,{repositoryId:123,legacy:[],templateSource:true})).rejects.toThrow('INSTRUCTIONS_BYTES_DIFFER');
    await expect(assertRepositoryInstructions(root,current,{repositoryId:123,legacy})).rejects.toThrow('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION');
    await writeFile(join(root,'AGENTS.md'),current);
    await expect(assertRepositoryInstructions(root,current,{repositoryId:124,legacy,templateSource:true})).rejects.toThrow('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION');
    await writeFile(template,Buffer.concat([next,Buffer.from('Candidate edit\n')]));
    await expect(assertRepositoryInstructions(root,current,{repositoryId:123,legacy,templateSource:true})).rejects.toThrow('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION');
    const malformed=Buffer.from(next.toString().replaceAll('\n','\r\n'));await writeFile(template,malformed);
    await expect(assertRepositoryInstructions(root,current,{repositoryId:123,legacy:[{repositoryId:123,sha256:createHash('sha256').update(malformed).digest('hex')}],templateSource:true})).rejects.toThrow('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION');
    await writeFile(join(root,'AGENTS.md'),next);await writeFile(template,next);
    await expect(assertRepositoryInstructions(root,next,{repositoryId:123,legacy:[],templateSource:true})).resolves.toBeUndefined();
    await writeFile(template,current);
    await expect(assertRepositoryInstructions(root,next,{repositoryId:123,legacy:[],templateSource:true})).rejects.toThrow('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION');
  }finally{await rm(root,{recursive:true,force:true});}
});
it.each(['managed-sync','render-review-instructions'])('retired %s cannot reach credentials or transport',async command=>{
  const network=vi.fn(()=>{throw Error('No transport');});vi.stubGlobal('fetch',network);vi.stubEnv('STEWARD_APP_PRIVATE_KEY','');
  try{await expect(main([command])).rejects.toThrow('未知命令');expect(network).not.toHaveBeenCalled();}
  finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
});
