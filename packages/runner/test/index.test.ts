import {it,expect,vi} from 'vitest';
import {main,parseInvocation} from '../src/index.js';
it.each(['pr-classification','validate','validation-profile','managed-repository-ids','review-trigger-mode','trusted-policy-source','sync-review-instructions','release-candidate','release-produce','release-build','sync-managed-labels','onboard-repository','render-review-instructions','managed-sync'])('retired %s cannot reach credentials or network',async command=>{
  const network=vi.fn(()=>{throw Error('Unexpected network');});vi.stubGlobal('fetch',network);
  try{await expect(main([command])).rejects.toThrow('未知命令');expect(network).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
});
it('accepts only finite unique paired arguments',()=>{
  expect(parseInvocation(['release-freeze','--workspace','.']).args.workspace).toBe('.');
  for(const args of [['release-freeze','--unknown','x'],['release-freeze','--workspace'],['release-freeze','--workspace','.','--workspace','x']])expect(()=>parseInvocation(args)).toThrow();
});
it('does not export retired writers or task interpreters',async()=>{
  const runner=await import('../src/index.js');
  for(const name of ['writeManagedFilesToBranch','assertManagedBranchPull','reviewInstructionSyncInstallationPermissions','validateReleaseSource','admitReleaseIdentity','releaseWriteAuthority','parseRepositoryCatalog','verifyValidationEntry','runValidationTasks'])expect(runner).not.toHaveProperty(name);
});
