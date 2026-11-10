import {it,expect} from 'vitest';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const script=()=>import(pathToFileURL(resolve('scripts/discover-maintenance-toolchain.mjs')).href);
it('separates official latest/current-major discovery and npm engine compatibility from approval',async()=>{
  const {discover}=await script();
  const nodes=[{version:'v24.1.0',lts:'LTS',npm:'11.1.0'},{version:'v24.2.0',lts:'LTS',npm:'11.2.0'},
    {version:'v26.0.0',lts:false,npm:'12.0.0'},{version:'v27.0.0-rc.1'}];
  const npm={name:'npm','dist-tags':{latest:'12.0.0'},versions:{
    '11.1.0':{version:'11.1.0',engines:{node:'>=24'}},'11.2.0':{version:'11.2.0',engines:{node:'>=24.2'}},
    '12.0.0':{version:'12.0.0',engines:{node:'>=26'}}}};
  const value=discover(nodes,npm,{node:'24.1.0',npm:'11.1.0'});
  expect(value.node.latestStable.version).toBe('26.0.0');expect(value.node.latestCurrentMajor.version).toBe('24.2.0');
  expect(value.npm.latestStable.version).toBe('12.0.0');expect(value.npm.latestCompatibleWithCurrentNode.version).toBe('11.1.0');
  expect(value.npm.latestCompatibleWithCurrentMajorCandidate.version).toBe('11.2.0');
  expect(value.decision).toBe('DISCOVERED_NOT_APPROVED');
  expect(()=>discover(nodes,{...npm,name:'untrusted'},{node:'24.1.0',npm:'11.1.0'})).toThrow();
  expect(()=>discover(nodes,npm,{node:'22.0.0',npm:'11.1.0'})).toThrow();
});
