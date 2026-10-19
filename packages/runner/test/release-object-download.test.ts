import { afterEach, expect, it, vi } from 'vitest';
import { ReleaseReceiptClient } from '../src/release-lifecycle.js';
import { receiptDigest } from '../../core/src/release-note-receipt.js';
afterEach(() => vi.useRealTimers());
it('downloads the maximum object out of order with eight workers and verifies its digest', async () => {
 vi.useFakeTimers(); const bytes = Buffer.alloc(32 * 1024 * 1024, 7), total = Math.ceil(bytes.length / 49152);
 let active = 0, peak = 0, calls = 0;
 const client = new ReleaseReceiptClient('https://runtime.example', 'token', 1, 'v1.0.0', (async url => {
  const part = Number(String(url).split('/').at(-1)); calls++; active++; peak = Math.max(peak, active);
  await new Promise(resolve => setTimeout(resolve, part % 2 ? 2000 : 1000)); active--;
  return Response.json({ total, bytes_base64: bytes.subarray(part * 49152, (part + 1) * 49152).toString('base64') });
 }) as typeof fetch);
 const pending = client.getObject(receiptDigest(bytes)); await vi.advanceTimersByTimeAsync(180000);
 expect(receiptDigest(await pending)).toBe(receiptDigest(bytes)); expect(calls).toBe(total); expect(peak).toBe(8); expect(active).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it.each([
 [{total: 0, bytes_base64: 'YQ=='}, 'OBJECT_MISSING'],
 [{total: 1, bytes_base64: 'YQ'}, 'OBJECT_LIMIT'],
 [{total: 1, bytes_base64: 'Yg=='}, 'SOURCE_DIGEST'],
])('rejects malformed or corrupted objects', async (row, error) => {
 const client = new ReleaseReceiptClient('https://runtime.example', 'token', 1, 'v1.0.0', (async () => Response.json(row)) as typeof fetch);
 await expect(client.getObject(receiptDigest('a'))).rejects.toThrow(error);
});
it('cancels siblings and stops scheduling when a chunk changes the declared total', async () => {
 let calls = 0, aborted = 0;
 const client = new ReleaseReceiptClient('https://runtime.example', 'token', 1, 'v1.0.0', (async (url, init) => {
  const part = Number(String(url).split('/').at(-1)); calls++;
  if (!part) return Response.json({total: 100, bytes_base64: 'YQ=='});
  if (part === 1) return Response.json({total: 99, bytes_base64: 'YQ=='});
  return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted++; reject(init!.signal!.reason); }, {once: true}));
 }) as typeof fetch);
 await expect(client.getObject(receiptDigest('a'))).rejects.toThrow('OBJECT_INCOMPLETE');
 expect(calls).toBe(9); expect(aborted).toBe(7);
});
it('bounds a stalled initial download by the same whole-object deadline', async () => {
 vi.useFakeTimers(); let aborted = false;
 const client = new ReleaseReceiptClient('https://runtime.example', 'token', 1, 'v1.0.0', (async (_url, init) => new Promise((_resolve, reject) => {
  init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, {once: true});
 })) as typeof fetch);
 const pending = expect(client.getObject(receiptDigest('a'))).rejects.toThrow('5 分钟');
 await vi.advanceTimersByTimeAsync(300000); await pending; expect(aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
