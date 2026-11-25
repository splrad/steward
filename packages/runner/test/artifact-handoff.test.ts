import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { artifactDownloadTimeout, downloadArtifactArchive } from '../src/artifact-handoff.js';
import { zip } from './fixtures/artifact-envelope.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('calculates the timeout from the permitted archive size', () => {
  expect(artifactDownloadTimeout(4 * 1024 ** 3 + 16 * 1024 ** 2)).toBe(1088000);
  expect(artifactDownloadTimeout(1)).toBe(61000);
  expect(() => artifactDownloadTimeout(4 * 1024 ** 3 + 16 * 1024 ** 2 + 1)).toThrow();
});

it.each(['digest', 'stream', 'recheck', 'host', 'existing'])('preserves the destination and permits retry after %s', async fault => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-retry-'));
  roots.push(root);
  const path = join(root, 'archive'), bytes = zip();
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  let failed = true;
  const transport: typeof fetch = async (_url, options) => {
    if (options?.redirect === 'manual') return new Response(null, {status: 302, headers: {
      location: failed && fault === 'host' ? 'https://invalid.example/item' : 'https://storage.blob.core.windows.net/item',
    }});
    expect(options?.headers).toBeUndefined();
    if (failed && fault === 'stream') return new Response(new ReadableStream({start(c) { c.error(Error('interrupted')); }}));
    return new Response(bytes);
  };
  const download = () => downloadArtifactArchive(transport, 'fixture', 'fixture/product', 9, bytes.length,
    failed && fault === 'digest' ? 'sha256:' + '0'.repeat(64) : digest, path, async () => {
      if (failed && fault === 'recheck') throw Error('attempt changed');
    });
  if (fault === 'existing') await writeFile(path, 'original');
  await expect(download()).rejects.toThrow();
  if (fault === 'existing') {
    expect(await readFile(path, 'utf8')).toBe('original');
    return;
  }
  await expect(readFile(path)).rejects.toMatchObject({code: 'ENOENT'});
  failed = false;
  await download();
  expect(await readFile(path)).toEqual(bytes);
});
