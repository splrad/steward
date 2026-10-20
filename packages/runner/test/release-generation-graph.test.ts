import { it, expect, vi } from 'vitest';
import { runGenerationGraph } from '../src/release-generation-graph.js';
const output = JSON.stringify({ userNotes: { upgrade: [], changes: [{ category: '修复', text: '修复输出。' }] },
  reviewEvidence: { internalChanges: [], unknowns: [] } });
function mock() {
  const bodies: any[] = [];
  let done = false;
  const request = vi.fn(async (_path: string, body: any) => {
    bodies.push(body);
    if (body.action === 'status') return { complete: done, ready: ['source:0'], callsRemaining: 60, runsRemaining: 1 };
    if (body.action === 'reserve') return { reservation: 'nonce', input: 'source' };
    if (body.action === 'complete') done = true;
    if (body.action === 'result') return { output };
    return {};
  });
  return { bodies, request, client: { request } as any };
}
it('uses persisted status and returns only a completed root result', async () => {
  const f = mock(), invoke = vi.fn(async () => output);
  expect((await runGenerationGraph(f.client, invoke)).complete).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(f.bodies.map(b => b.action)).toEqual(['status', 'reserve', 'complete', 'status', 'result']);
});
it('yields before a deadline without issuing another provider request', async () => {
  const f = mock(), invoke = vi.fn(async () => output);
  let calls = 0;
  expect(await runGenerationGraph(f.client, invoke, () => calls++ ? 1e9 : 0)).toEqual({ complete: false });
  expect(invoke).not.toHaveBeenCalled();
  expect(f.bodies.map(b => b.action)).toEqual(['status', 'yield']);
});
it('does not retry a provider call with unknown outcome in the same segment', async () => {
  const f = mock(), invoke = vi.fn(async () => { throw new Error('network'); });
  await expect(runGenerationGraph(f.client, invoke)).rejects.toThrow('network');
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(f.bodies.map(b => b.action)).toEqual(['status', 'reserve']);
});
it('records malformed output before retrying the node under its persisted attempt cap', async () => {
  const f = mock(), invoke = vi.fn().mockResolvedValueOnce('invalid').mockResolvedValueOnce(output);
  expect((await runGenerationGraph(f.client, invoke)).complete).toBe(true);
  expect(f.bodies.filter(b => b.action === 'diagnostic')).toHaveLength(1);
});
