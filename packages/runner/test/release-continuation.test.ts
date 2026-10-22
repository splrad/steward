import {it,expect,vi,afterEach} from 'vitest';
import {dispatchWorkflow,GitHubRequestError,ReleasePolicyDriftError,type GitHubClient} from '../../github/src/index.js';
import {dispatchReleaseContinuation,validateContinuationRecovery} from '../src/release-continuation.js';
vi.mock('../../github/src/index.js',async original=>({...await original<any>(),dispatchWorkflow:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
it('releases a continuation reservation after policy drift prevents the POST',async()=>{
 const error=new ReleasePolicyDriftError();vi.mocked(dispatchWorkflow).mockRejectedValue(error);
 const release=vi.fn();const recovery={persist:vi.fn(),clear:vi.fn()};
 await expect(dispatchReleaseContinuation(async()=>({} as GitHubClient),'a'.repeat(40),{},release,recovery)).rejects.toBe(error);
 expect(recovery.persist).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledOnce();expect(recovery.clear).toHaveBeenCalledOnce();
});
it.each([400,401,403,404,422,408,429,500])('releases only definitive dispatch rejection %s',async status=>{
 const error=new GitHubRequestError(status,'POST','/repos/splrad/steward/actions/workflows/release.yml/dispatches','failure');
 vi.mocked(dispatchWorkflow).mockRejectedValue(error);const release=vi.fn();
 await expect(dispatchReleaseContinuation(async()=>({} as GitHubClient),'a'.repeat(40),{},release)).rejects.toBe(error);
 expect(release).toHaveBeenCalledTimes([400,401,403,404,422].includes(status)?1:0);
});
it.each(['token','get','network'])('handles %s failure at the dispatch boundary',async stage=>{
 const error=stage==='get'?new GitHubRequestError(503,'GET','/repos/splrad/steward','failure'):Error('unavailable');
 const release=vi.fn();vi.mocked(dispatchWorkflow).mockRejectedValue(error);
 await expect(dispatchReleaseContinuation(async()=>{if(stage==='token')throw error;return {} as GitHubClient;},'a'.repeat(40),{},release)).rejects.toBe(error);
 expect(release).toHaveBeenCalledTimes(stage==='network'?0:1);
});

it('persists definite-rejection cleanup before retrying and clears it on success',async()=>{
 const error=new GitHubRequestError(422,'POST','/repos/splrad/steward/actions/workflows/release.yml/dispatches','rejected');
 vi.mocked(dispatchWorkflow).mockRejectedValue(error);
 const events:string[]=[];let attempts=0;
 const recovery={persist:async()=>{events.push('persist');},clear:async()=>{events.push('clear');},pause:async()=>{}};
 const release=async()=>{events.push('release');if(++attempts<3)throw Error('503');};
 await expect(dispatchReleaseContinuation(async()=>({} as GitHubClient),'a'.repeat(40),{},release,recovery)).rejects.toBe(error);
 expect(events).toEqual(['persist','release','release','release','clear']);
});
it('retains the persisted recovery record after all cleanup attempts fail',async()=>{
 vi.mocked(dispatchWorkflow).mockRejectedValue(new GitHubRequestError(422,'POST','/repos/splrad/steward/actions/workflows/release.yml/dispatches','rejected'));
 const recovery={persist:vi.fn(),clear:vi.fn(),pause:async()=>{}};const release=vi.fn().mockRejectedValue(Error('503'));
 await expect(dispatchReleaseContinuation(async()=>({} as GitHubClient),'a'.repeat(40),{},release,recovery)).rejects.toThrow('CLEANUP_PENDING');
 expect(release).toHaveBeenCalledTimes(3);expect(recovery.persist).toHaveBeenCalledOnce();expect(recovery.clear).not.toHaveBeenCalled();
});
it('never creates a release record for an unknown dispatch outcome',async()=>{
 vi.mocked(dispatchWorkflow).mockRejectedValue(Error('network'));
 const recovery={persist:vi.fn(),clear:vi.fn()};const release=vi.fn();
 await expect(dispatchReleaseContinuation(async()=>({} as GitHubClient),'a'.repeat(40),{},release,recovery)).rejects.toThrow('network');
 expect(recovery.persist).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();
});

it('accepts generated SHA-256 recovery bindings and rejects commit SHAs and mismatched identities',()=>{
 const identity={repositoryId:42,tag:'v1.2.3',policySha:'a'.repeat(40)};
 const record={version:1,reason:'dispatch-not-accepted',frozen:{repositoryId:42,targetTag:identity.tag,policySha:identity.policySha},graphDigest:'b'.repeat(64),reservation:'continuation:7'};
 expect(validateContinuationRecovery(record,identity)).toBe(record);
 for(const change of [{graphDigest:'b'.repeat(40)},{graphDigest:'g'.repeat(64)},{reservation:'other:7'},{reason:'unknown'}])expect(()=>validateContinuationRecovery({...record,...change},identity)).toThrow('GENERATION_RECOVERY');
 expect(()=>validateContinuationRecovery(record,{...identity,repositoryId:43})).toThrow('GENERATION_RECOVERY');
});
