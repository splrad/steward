import { afterEach, expect, it, vi } from 'vitest';
import { parseNativeInvocation, nativeReleaseCli } from '../src/native-release-cli.js';
afterEach(() => vi.restoreAllMocks());
it.each(['validate', 'prepare', 'publish'])('rejects retired release-admission %s before any API or subprocess', async operation => {
  await expect(nativeReleaseCli(['release-admission', operation])).rejects.toThrow('unknown command');
});
it('requires every finite build identity argument and rejects unknown commands/flags', () => {
  const argv = ['release-pipeline', 'identity', '--cycle-id', 'pr-1-' + 'a'.repeat(40), '--operation-key', 'c'.repeat(64),
    '--source-sha', 'a'.repeat(40), '--controller-sha', 'b'.repeat(40), '--source-dir', 'source', '--controller-dir', 'controller', '--state-dir', 'state', '--output', 'out.json'];
  expect(parseNativeInvocation(argv).command).toBe('release-pipeline identity');
  for (let i = 2; i < argv.length; i += 2) expect(() => parseNativeInvocation([...argv.slice(0, i), ...argv.slice(i + 2)])).toThrow('missing');
  expect(() => parseNativeInvocation([...argv, '--output', 'other'])).toThrow('duplicate');
  expect(() => parseNativeInvocation([...argv, '--token', 'fixture'])).toThrow('unknown');
  expect(() => parseNativeInvocation(['release-pipeline', 'build'])).toThrow('unknown command');
});
it.each(['preview','targets','authorize','preflight','apply'])('rejects retired managed-sync %s at argument parsing', action=>{
  expect(()=>parseNativeInvocation(['managed-sync',action])).toThrow('unknown command');
});
it.each(['targets','preflight'])('rejects retired catalog-based dependency-updates %s before any operation',async action=>{
  await expect(nativeReleaseCli(['dependency-updates',action])).rejects.toThrow('unknown command');
});
