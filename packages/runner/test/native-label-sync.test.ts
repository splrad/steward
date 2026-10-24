import { expect, it } from 'vitest';
import { NativeLabelSync, parseAutoLabels } from '../src/native-label-sync.js';
import type { NativeControlPlane } from '../src/native-control-plane.js';
import labels from '../../../config/labels/auto.json' with { type: 'json' };
const P = 'a'.repeat(40);
function fixture() {
  const calls: string[][] = [], actual = [{ name: 'security', color: 'ff0000', description: 'Human controlled' }];
  const state = { enabled: true, changed: false, lost: false, denied: false, checks: 0, policyReads: 0 };
  const gh = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'api') return JSON.stringify([actual]);
    if (args[0] !== 'label' || args[1] !== 'create' || !args[2]?.startsWith('auto/') || !args.includes('--force')) throw new Error('unexpected command');
    if (state.denied) throw new Error('denied');
    const label = { name: args[2], color: args[args.indexOf('--color') + 1]!, description: args[args.indexOf('--description') + 1]! };
    const index = actual.findIndex(item => item.name === label.name); if (index < 0) actual.push(label); else actual[index] = label;
    if (state.changed) state.enabled = false;
    if (state.lost) throw new Error('lost response');
    return '';
  };
  const plane = { async syncPreflight() { state.checks++; return state.enabled ? { mode: 'enabled', repository: { fullName: 'splrad/LayerScape' }, expectedBaseSha: 'b'.repeat(40) } : { mode: 'not-enabled' }; } } as unknown as Pick<NativeControlPlane, 'syncPreflight'>;
  const sync = new NativeLabelSync(gh, plane, { head: async () => P, file: async () => { state.policyReads++; return Buffer.from(JSON.stringify(labels)); }, blob: async () => { throw new Error('unused'); } });
  return { sync, calls, actual, state };
}
it('previews auto definitions without modifying human labels or calling write transport', async () => {
  const f = fixture(); expect((await f.sync.run(1187527897, P, 'policy', false)).labels).toEqual(labels.labels.map(label => label.name));
  expect(f.calls.every(args => args[0] === 'api')).toBe(true); expect(f.actual).toHaveLength(1);
});
it('reads back unknown write responses and makes the next run a no-op', async () => {
  const f = fixture(); f.state.lost = true;
  expect((await f.sync.run(1187527897, P, 'policy', true)).writes).toBe(3);
  expect(f.actual[0]).toEqual({ name: 'security', color: 'ff0000', description: 'Human controlled' });
  const count = f.calls.length; expect((await f.sync.run(1187527897, P, 'policy', true)).changed).toBe(false);
  expect(f.calls.slice(count).every(args => args[0] === 'api')).toBe(true);
});
it('disabled targets do not read policy inputs or touch target APIs', async () => {
  const f = fixture(); f.state.enabled = false;
  expect((await f.sync.run(1187527897, P, 'policy', true)).writes).toBe(0);
  expect(f.calls).toEqual([]); expect(f.state.policyReads).toBe(0);
});
it('rechecks current authority before every label write', async () => {
  const f = fixture(); f.state.changed = true;
  await expect(f.sync.run(1187527897, P, 'policy', true)).rejects.toThrow('paused');
  expect(f.calls.filter(args => args[0] === 'label')).toHaveLength(1);
});
it('does not turn a failed write into successful synchronization', async () => {
  const f = fixture(); f.state.denied = true;
  await expect(f.sync.run(1187527897, P, 'policy', true)).rejects.toThrow('denied');
});
it.each(['security', 'risk/high', 'release/approved', '--force', 'auto/../../risk', ['auto/docs'], '', null])('rejects an unowned or malformed name %s', name => {
  const value: any = structuredClone(labels); value.labels[0].name = name;
  expect(() => parseAutoLabels(value)).toThrow();
});
it('rejects duplicate definitions and unknown fields', () => {
  expect(() => parseAutoLabels({ ...labels, execute: 'script' })).toThrow();
  expect(() => parseAutoLabels({ ...labels, labels: [labels.labels[0], labels.labels[0]] })).toThrow();
});
