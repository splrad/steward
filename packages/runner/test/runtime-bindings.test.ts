import { permitOfflineCommand } from './offline-fixtures.js';
import {spawnSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {beforeAll,afterAll,it,expect} from 'vitest';
const root=resolve('.');
permitOfflineCommand(process.execPath, [join(root, 'scripts/verify-config.mjs')]);let fixture:string;let config:string;
beforeAll(async()=>{
 fixture=await mkdtemp(join(tmpdir(),'steward-binding-contract-'));
 await cp('config',join(fixture,'config'),{recursive:true});
  for (const path of ['mise.toml', 'mise.lock', '.mise', 'package.json', 'package-lock.json']) await cp(path, join(fixture, path), { recursive: true });await cp('schema',join(fixture,'schema'),{recursive:true});
 await mkdir(join(fixture,'packages/runtime'),{recursive:true});config=await readFile('packages/runtime/wrangler.toml','utf8');
});
afterAll(async()=>{if(fixture)await rm(fixture,{recursive:true,force:true});});
it.each(['valid','class','migration','extra','database','kv'])('enforces exact runtime binding contract: %s',async change=>{
 let text=config;
 if(change==='class')text=text.replace('new_sqlite_classes = ["ValidationCoordinator"]','new_sqlite_classes = ["OtherCoordinator"]');
 if(change==='migration')text=text.replace('validation-coordinator-v1','arbitrary-v2');
 if(change==='extra')text+='\n[[durable_objects.bindings]]\nname = "OTHER"\nclass_name = "Other"\n';
 if(change==='database')text=text.replace('75ae2ef8-683d-4a44-b113-e58961473d03','00000000-0000-0000-0000-000000000000');
 if(change==='kv')text+='\n[[kv_namespaces]]\nbinding = "CACHE"\nid = "123"\n';
 await writeFile(join(fixture,'packages/runtime/wrangler.toml'),text);
 const result=spawnSync(process.execPath,[join(root,'scripts/verify-config.mjs')],{cwd:fixture,encoding:'utf8'});
 expect(result.status,result.stderr).toBe(change==='valid'?0:1);
 if(change!=='valid')expect(result.stderr).toMatch(/固定合同|固定D1|禁止绑定|历史迁移/);
});
