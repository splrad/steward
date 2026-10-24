import { expect, it, vi } from 'vitest';
import { mergeManagedFile, type ManagedFileRule } from '../src/managed-file-merge.js';
// Only Git's fixed merge-file invocation may run; no hooks, repository or network.
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawnSync(command: string, args: string[], options: any) {
    if (command !== 'git' || JSON.stringify(args.slice(0, 9)) !== '["merge-file","-p","--diff3","-L","CURRENT","-L","BASE","-L","NEW"]'
      || args.length !== 12 || options.shell !== false) throw new Error('TEST_SUBPROCESS_DENIED');
    return original.spawnSync(command, args, options);
  } };
});
const rule: ManagedFileRule = { source: 'template', destination: 'AGENTS.md', mode: 'whole', dependencyFields: [] };
it('uses real Git to preserve independent human changes and reject conflicts', async () => {
  expect(await mergeManagedFile('human\nb\nc\n', 'a\nb\nc\n', 'a\nb\ncentral\n', rule)).toBe('human\nb\ncentral\n');
  await expect(mergeManagedFile('human\n', 'base\n', 'central\n', rule)).rejects.toThrow('CONFLICT');
  expect(await mergeManagedFile('same\n', 'same\n', 'same\n', rule)).toBe('same\n');
});
it('preserves the unowned bytes of a section', async () => {
  const section = { ...rule, mode: 'section' as const, startMarker: '<!-- begin -->', endMarker: '<!-- end -->' };
  const base = 'original\n<!-- begin -->\nold\n<!-- end -->\nend\n';
  expect(await mergeManagedFile(base.replace('original', 'human'), base, base.replace('old', 'new'), section))
    .toBe(base.replace('original', 'human').replace('old', 'new'));
  await expect(mergeManagedFile(base + '<!-- begin -->', base, base, section)).rejects.toThrow('ambiguous');
  await expect(mergeManagedFile(base.replace('old', '<!-- begin nested -->\nold\n<!-- end nested -->'), base, base, section)).rejects.toThrow('nested');
  await expect(mergeManagedFile(base.replace('<!-- begin -->', 'inline <!-- begin -->'), base, base, section)).rejects.toThrow('own line');
});
it('retains a product Renovate update while merging a central structural update', async () => {
  const base = `jobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n      - id: checkout\n        uses: actions/checkout@${'a'.repeat(40)}\n        with:\n          persist-credentials: false\n`;
  const current = base.replace('a'.repeat(40), 'b'.repeat(40));
  const next = base.replace('ubuntu-24.04', 'ubuntu-latest');
  const workflow = { ...rule, dependencyFields: [{ jobId: 'build', stepId: 'checkout', path: ['uses'] as ['uses'] }] };
  expect(await mergeManagedFile(current, base, next, workflow)).toBe(next.replace('a'.repeat(40), 'b'.repeat(40)));
  await expect(mergeManagedFile(current.replace('id: checkout', 'id: other'), base, next, workflow)).rejects.toThrow('dependency step');
  await expect(mergeManagedFile(current.replace('b'.repeat(40), 'main'), base, next, workflow)).rejects.toThrow('pinned');
});
