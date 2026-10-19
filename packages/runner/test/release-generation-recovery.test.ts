import { expect, it, vi } from 'vitest';
import { ReleaseReceiptClient } from '../src/release-lifecycle.js';

it('explains full-job recovery for rejected generation tickets without retrying', async () => {
  const transport = vi.fn(async () => new Response(JSON.stringify({ error: 'RN_RECEIPT_GENERATION_AUTH' }), { status: 409 }));
  const client = new ReleaseReceiptClient('https://runtime.example/', 'release-generation.secret', 9001, 'v1.2.3', transport);
  await expect(client.request('generation', { action: 'prepare' })).rejects.toThrow('Re-run all jobs');
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each([
  ['installation-token', 'generation', '{"error":"RN_RECEIPT_GENERATION_AUTH"}'],
  ['release-generation.secret', 'generation', '{"error":"RN_RECEIPT_GENERATION_STALE"}'],
  ['release-generation.secret', 'generation', 'invalid response'],
  ['release-generation.secret', 'claim', '{"error":"RN_RECEIPT_GENERATION_AUTH"}'],
])('preserves other runtime failures (%s, %s, %s)', async (token, action, body) => {
  const client = new ReleaseReceiptClient('https://runtime.example/', token, 9001, 'v1.2.3', async () => new Response(body, { status: 409 }));
  await expect(client.request(action, {})).rejects.toThrow(`release-runtime-409:${body}`);
});
