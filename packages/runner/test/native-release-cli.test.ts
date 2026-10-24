import { afterEach, expect, it, vi } from 'vitest';
import { localGitSnapshot } from '../src/managed-sync-preview.js';
import catalog from '../../../config/repositories.json' with { type: 'json' };
import { parseNativeInvocation, nativeReleaseCli } from '../src/native-release-cli.js';
afterEach(() => vi.restoreAllMocks());
it.each(['missing', 'drift'])('rejects an offline central config not bound to P: %s', async kind => {
  const pinned = structuredClone(catalog);
  pinned.repositories['1187527897'].release.units.layerscape.channels['ghcr-assets'].destination += '-old';
  const snapshot = vi.spyOn(localGitSnapshot, 'file').mockResolvedValue(kind === 'missing' ? null : Buffer.from(JSON.stringify(pinned)));
  await expect(nativeReleaseCli(['release-admission', 'validate', '--repository', 'splrad/LayerScape', '--source-sha', 'a'.repeat(40), '--policy-sha', 'b'.repeat(40), '--descriptor', 'source/.github/steward-release.json', '--central-config', 'config/repositories.json', '--offline', '--output', 'unused.json'])).rejects.toThrow('central config differs from policy');
  expect(snapshot).toHaveBeenCalledOnce();
});
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
