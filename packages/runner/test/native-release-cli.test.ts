import { expect, it } from 'vitest';
import { parseNativeInvocation, nativeReleaseCli } from '../src/native-release-cli.js';
it('requires every offline admission argument and rejects unknown commands/flags', async () => {
  const argv = ['release-admission', 'validate', '--repository', 'splrad/LayerScape', '--source-sha', 'a'.repeat(40), '--policy-sha', 'b'.repeat(40), '--descriptor', 'source/.github/steward-release.json', '--central-config', 'config/repositories.json', '--offline', '--output', 'out.json'];
  expect(parseNativeInvocation(argv).args.offline).toBe('true');
  for (let i = 2; i < argv.length; i++) {
    if (argv[i]!.startsWith('--')) expect(() => parseNativeInvocation([...argv.slice(0, i), ...argv.slice(i + (argv[i] === '--offline' ? 1 : 2))])).toThrow('missing');
  }
  expect(() => parseNativeInvocation([...argv, '--output', 'other'])).toThrow('duplicate');
  expect(() => parseNativeInvocation([...argv, '--token', 'fixture'])).toThrow('unknown');
  await expect(nativeReleaseCli(['release-admission', 'publish'])).rejects.toThrow('unknown command');
});
it('requires a canonical sync mode and complete local directories', () => {
  expect(() => parseNativeInvocation(['managed-sync', 'preview', '--repository-id', '1187527897'])).toThrow('missing');
  expect(parseNativeInvocation(['managed-sync', 'preview', '--repository-id', '1187527897', '--mode', 'sync', '--policy-dir', 'policy', '--target-dir', 'target', '--output-dir', 'new']).command).toBe('managed-sync preview');
});
