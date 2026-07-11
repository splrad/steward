import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundleAction } from './bundle-action.mjs';

async function files(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, child));
    else result.push(child.replaceAll('\\', '/'));
  }
  return result.sort();
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'steward-dist-'));
const output = path.join(temporaryRoot, 'dist');

try {
  await bundleAction(output);

  const committed = path.resolve('action/dist');
  const [committedFiles, generatedFiles] = await Promise.all([files(committed), files(output)]);
  if (JSON.stringify(committedFiles) !== JSON.stringify(generatedFiles)) {
    throw new Error('action/dist file list does not match a clean build');
  }

  for (const file of committedFiles) {
    const [left, right] = await Promise.all([
      readFile(path.join(committed, file)),
      readFile(path.join(output, file)),
    ]);
    if (!left.equals(right)) throw new Error(`action/dist/${file} is not reproducible`);
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
