import {it,expect,vi,afterEach} from 'vitest';
import {dispatchWorkflow,GitHubRequestError,type GitHubClient} from '../../github/src/index.js';
import {dispatchReleaseContinuation} from '../src/release-continuation.js';
vi.mock('../../github/src/index.js',async original=>({...await original<any>(),dispatchWorkflow:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
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
