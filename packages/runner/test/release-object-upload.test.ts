import { afterEach, expect, it, vi } from 'vitest';
import { ReleaseReceiptClient } from '../src/release-lifecycle.js';
import { receiptDigest } from '../../core/src/release-note-receipt.js';
afterEach(() => vi.useRealTimers());
it('uploads 32 MiB in bounded parallel batches within the plan upload budget', async () => {
  vi.useFakeTimers();
  const bytes = new Uint8Array(32 * 1024 * 1024);
  let active = 0, peak = 0;
  const parts = new Map<number, Buffer>();
  const client = new ReleaseReceiptClient('https://runtime.example', 'token', 1, 'v1.0.0', (async (url, init) => {
    active++; peak = Math.max(peak, active);
    const body = JSON.parse(init!.body as string);
    parts.set(Number(String(url).split('/').at(-1)), Buffer.from(body.bytesBase64, 'base64'));
    await new Promise(resolve => setTimeout(resolve, 2000)); active--;
    return new Response('{}');
  }) as typeof fetch);
  const started = Date.now();
  const pending = client.putObject(bytes);
  await vi.advanceTimersByTimeAsync(172000);
  expect(await pending).toBe(receiptDigest(bytes));
  expect(Date.now() - started).toBe(172000);
  expect(peak).toBe(8); expect(parts.size).toBe(683);
  expect(receiptDigest(Buffer.concat([...parts.entries()].sort(([a], [b]) => a-b).map(([, b]) => b)))).toBe(receiptDigest(bytes));
  expect(vi.getTimerCount()).toBe(0);
});
it('aborts every in-flight chunk at the shared upload deadline without scheduling more', async () => {
  vi.useFakeTimers(); let calls = 0, aborted = 0;
  const client = new ReleaseReceiptClient('https://runtime.example', 'token', 1, 'v1.0.0', (async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted++; reject(init!.signal!.reason); }, { once: true }));
  }) as typeof fetch);
  const pending = expect(client.putObject(new Uint8Array(1024 * 1024))).rejects.toThrow('5 分钟');
  await vi.advanceTimersByTimeAsync(300000); await pending;
  expect(calls).toBe(8); expect(aborted).toBe(8); expect(vi.getTimerCount()).toBe(0);
});
