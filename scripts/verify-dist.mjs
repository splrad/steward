import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundleAction } from './bundle-action.mjs';
import { bundleCli } from './bundle-cli.mjs';
import { runProcess } from './process.mjs';

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
try {
  for (const target of [
    { name: 'action/dist', bundle: bundleAction },
    { name: 'packages/cli/dist', bundle: bundleCli },
  ]) {
    const output = path.join(temporaryRoot, target.name.replaceAll('/', '-'));
    await target.bundle(output);
    const committed = path.resolve(target.name);
    const [committedFiles, generatedFiles] = await Promise.all([files(committed), files(output)]);
    if (JSON.stringify(committedFiles) !== JSON.stringify(generatedFiles)) {
      throw new Error(`${target.name} file list does not match a clean build`);
    }
    for (const file of committedFiles) {
      const [left, right] = await Promise.all([
        readFile(path.join(committed, file)),
        readFile(path.join(output, file)),
      ]);
      if (!left.equals(right)) throw new Error(`${target.name}/${file} is not reproducible`);
    }
    if (target.name === 'packages/cli/dist') {
      const dryRunTarget = path.join(temporaryRoot, 'cli-init-target');
      await mkdir(dryRunTarget);
      await runProcess(process.execPath, [
        path.join(output, 'index.js'),
        'init', '--dry-run',
        '--spec', path.resolve('tests/fixtures/cli/init-minimal.json'),
        '--target', dryRunTarget,
      ]);
      if ((await readdir(dryRunTarget)).length !== 0) throw new Error('bundled CLI init --dry-run modified its target');
    }
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
