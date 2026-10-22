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
  expect(f.bodies.map(b => b.action)).toEqual(['status', 'reserve', 'complete', 'status', 'result', 'yield']);
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
  expect(f.bodies.map(b => b.action)).toEqual(['status', 'reserve', 'yield']);
});
it('records malformed output before retrying the node under its persisted attempt cap', async () => {
  const f = mock(), invoke = vi.fn().mockResolvedValueOnce('invalid').mockResolvedValueOnce(output);
  expect((await runGenerationGraph(f.client, invoke)).complete).toBe(true);
  expect(f.bodies.filter(b => b.action === 'diagnostic')).toHaveLength(1);
});
it.each(['\x00', '\x1b', '\ud800', '\udfff'].flatMap(character =>
  ['upgrade', 'changes', 'internalChanges', 'unknowns'].map(field => ({character, field}))))
('repairs invalid $field text before persisting a completed node ($character)', async ({character, field}) => {
  const value = JSON.parse(output), text = `文本${character}内容`;
  if (field === 'changes') value.userNotes.changes[0].text = text;
  else if (field === 'upgrade') value.userNotes.upgrade = [text];
  else value.reviewEvidence[field] = [text];
  const f = mock(), invoke = vi.fn().mockResolvedValueOnce(JSON.stringify(value)).mockResolvedValueOnce(output);
  await runGenerationGraph(f.client, invoke);
  const writes = f.bodies.filter(b => ['diagnostic', 'complete'].includes(b.action));
  expect(writes.map(b => b.action)).toEqual(['diagnostic', 'complete']);
  expect(JSON.parse(writes[1].output)).toEqual(JSON.parse(output));
});
it('accepts a valid supplementary Unicode character without repair', async () => {
  const f = mock(), value = JSON.parse(output);
  value.userNotes.changes[0].text = '支持中文和表情😀。';
  await runGenerationGraph(f.client, vi.fn(async () => JSON.stringify(value)));
  expect(f.bodies.some(b => b.action === 'diagnostic')).toBe(false);
  expect(JSON.parse(f.bodies.find(b => b.action === 'complete').output)).toEqual(value);
});
