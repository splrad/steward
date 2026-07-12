import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeReleaseAdapter,
  parseReleaseAdapterCommand,
} from '../action/src/release-adapter.js';

const temporaryRoots: string[] = [];
const context = JSON.stringify({
  contractVersion: 1,
  repository: { id: 1296725030, fullName: 'splrad/steward-sandbox' },
  pullRequest: { number: 14, mergeSha: '0123456789012345678901234567890123456789' },
});
const adapter = path.resolve('tests/fixtures/release/adapter.mjs');

async function directories(): Promise<{ workspace: string; temporaryDirectory: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'steward-release-test-'));
  temporaryRoots.push(root);
  const workspace = path.join(root, 'workspace');
  const temporaryDirectory = path.join(root, 'runner-temp');
  await Promise.all([mkdir(workspace), mkdir(temporaryDirectory)]);
  return { workspace, temporaryDirectory };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('Release adapter execution', () => {
  it('runs plan and build without a shell and validates the produced inventory', async () => {
    const paths = await directories();
    const result = await executeReleaseAdapter({
      adapterCommand: JSON.stringify([process.execPath, adapter, 'success']),
      context,
      ...paths,
    });

    expect(result.plan).toMatchObject({ tagName: 'v1.2.3', displayVersion: '1.2.3' });
    expect(result.assets.assets).toEqual([expect.objectContaining({
      path: 'nested/fixture.zip',
      name: 'fixture.zip',
    })]);
    expect(path.dirname(result.outputDirectory)).toMatch(/steward-release-/);
  });

  it('rejects a manifest path that escapes the isolated output directory', async () => {
    const paths = await directories();
    await expect(executeReleaseAdapter({
      adapterCommand: JSON.stringify([process.execPath, adapter, 'unsafe-path']),
      context,
      ...paths,
    })).rejects.toThrow('contains an unsafe path segment');
  });

  it('rejects shell-shaped and malformed command values before execution', () => {
    expect(() => parseReleaseAdapterCommand(JSON.stringify(['node', 'script.mjs\nwhoami'])))
      .toThrow('single-line string');
    expect(() => parseReleaseAdapterCommand(JSON.stringify('node script.mjs')))
      .toThrow('JSON string array');
  });
});

