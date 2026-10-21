import {it,expect} from 'vitest';
import {verifyReleaseFormatCapabilities as verify} from '../src/release-format-capabilities.js';
const fixture=(profile:string,runnerFamily:string,match:string)=>({builds:{asset:{profile,inputs:{runnerFamily},outputs:[{id:'asset',kind:'file',match}]}},delivery:{githubRelease:{enabled:true,state:'pending' as const,profile:'release',builds:['asset']},deployments:[],packages:[]}});
it.each(['package.json','app.exe','*.dll','widget-{version}.zip'])('accepts current Windows inspector format %s',match=>{expect(()=>verify(fixture('custom-adapter-v1','windows',match))).not.toThrow();});
it.each(['*.tgz','*.zip','app.dll','*.json','artifact.*'])('rejects unsupported Linux Release format %s before activation',match=>{
 const config=fixture('custom-adapter-v1','linux',match);expect(()=>verify(config)).toThrow('RN_CONFIG_RELEASE_VERSION_INSPECTOR');
 config.delivery.githubRelease.builds=[];expect(()=>verify(config)).not.toThrow();
});
it('accepts package metadata on Linux while rejecting unsupported Node archives',()=>{
 expect(()=>verify(fixture('node-package-v1','linux','package.json'))).not.toThrow();
 expect(()=>verify(fixture('node-package-v1','linux','*.tgz'))).toThrow('RN_CONFIG_RELEASE_VERSION_INSPECTOR');
});
