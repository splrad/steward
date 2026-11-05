import { it,expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

it('fixed delivery child receives scoped tokens, no App/Copilot secrets, no dependency install, and private files',async()=>{
  const {deliverRepositoryTemplate}=await import(pathToFileURL(resolve('scripts/template-delivery.mjs')).href);
  const root=await mkdtemp(join(tmpdir(),'template-wrapper-test-'));
  try {
    const spawnChild=(executable:string,args:string[],options:any)=>{
      const child=new EventEmitter();
      queueMicrotask(async()=>{
        try {
          expect(executable).toBe('locked-uv');expect(args.slice(0,8)).toEqual(['run','--project','tools/template','--frozen','--no-sync','python','tools/template/delivery.py','--request']);
          expect(args.at(-1)).toBe('locked-gh');expect(options.stdio[1]).toBe(options.stdio[2]);
          expect(options.env.STEWARD_TEMPLATE_TOKEN).toBe('write-fixture');expect(options.env.STEWARD_TEMPLATE_READ_TOKEN).toBe('read-fixture');
          expect(options.env.STEWARD_CENTRAL_READ_TOKEN).toBe('central-fixture');
          expect(Object.keys(options.env).filter(k=>/PRIVATE_KEY|COPILOT|NODE_OPTIONS|PYTHONPATH/.test(k))).toEqual([]);
          const data=await readFile(args[args.indexOf('--request')+1]!,'utf8');expect(data).not.toContain('PRIVATE_KEY');
          for(const token of ['write-fixture','read-fixture','central-fixture'])expect(data).not.toContain(token);
          await writeFile(args[args.indexOf('--output')+1]!,JSON.stringify({status:'DELIVERED',head:'a'.repeat(40),pullRequest:2}));
          child.emit('close',0);
        }catch(error){child.emit('error',error);}
      });return child;
    };
    expect(await deliverRepositoryTemplate({repositoryId:12},{writeToken:'write-fixture',readToken:'read-fixture',centralReadToken:'central-fixture'},
      {root,resolveTool:async(name:string)=>'locked-'+name,spawnChild})).toEqual({status:'DELIVERED',head:'a'.repeat(40),pullRequest:2});
  }finally{await rm(root,{recursive:true,force:true});}
});
it('refuses shared write/read credentials before resolving tools or starting delivery',async()=>{
  const {deliverRepositoryTemplate}=await import(pathToFileURL(resolve('scripts/template-delivery.mjs')).href);
  let resolved=false;
  await expect(deliverRepositoryTemplate({}, {writeToken:'same',readToken:'same',centralReadToken:'central'},
    {resolveTool:async()=>{resolved=true;throw Error('not allowed');}})).rejects.toThrow('TEMPLATE_CREDENTIAL_BOUNDARY');
  expect(resolved).toBe(false);
});
it('does not promote an incomplete child result to successful delivery',async()=>{
  const {deliverRepositoryTemplate}=await import(pathToFileURL(resolve('scripts/template-delivery.mjs')).href);
  const root=await mkdtemp(join(tmpdir(),'template-wrapper-test-'));
  try {
    const spawnChild=(_exe:string,args:string[])=>{
      const child=new EventEmitter();queueMicrotask(async()=>{
        await writeFile(args[args.indexOf('--output')+1]!,JSON.stringify({status:'WAIT_REF_READBACK'}));child.emit('close',1);
      });return child;
    };
    await expect(deliverRepositoryTemplate({}, {writeToken:'write',readToken:'read',centralReadToken:'central'},
      {root,resolveTool:async(name:string)=>name,spawnChild})).rejects.toThrow('TEMPLATE_DELIVERY_INCOMPLETE');
  }finally{await rm(root,{recursive:true,force:true});}
});
