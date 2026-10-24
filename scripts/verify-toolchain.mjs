import { readFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';

export async function verifyToolchain(root = process.cwd()) {
  const result = spawnSync('mise', ['ls', '--json'], {
    cwd: root, shell: false, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, MISE_SAFE: '1', MISE_LOCKED: '1', MISE_NODE_COMPILE: 'false' },
  });
  if (result.error || result.status !== 0) throw new Error('mise locked tool inventory is unavailable');
  const inventory = JSON.parse(result.stdout);
  for (const tool of ['node', 'npm', 'aqua:rhysd/actionlint', 'aqua:zizmorcore/zizmor', 'aqua:cli/cli',
    'aqua:lycheeverse/lychee', 'aqua:oras-project/oras', 'aqua:anchore/syft']) {
    const entries = inventory[tool];
    if (!Array.isArray(entries) || entries.length !== 1 || !entries[0].installed || !entries[0].active
      || resolve(entries[0].source?.path ?? '') !== resolve(root, 'mise.toml')) {
      throw new Error(`missing locked tool: ${tool}`);
    }
  }
  const isInside = async (directory, file) => {
    const rel = relative(await realpath(directory), await realpath(file));
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (process.versions.node !== inventory.node[0].version
    || !await isInside(inventory.node[0].install_path, process.execPath)) throw new Error('Node does not match mise lock');
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !await isInside(inventory.npm[0].install_path, npmCli)) throw new Error('npm must run from mise lock');
  const npm = spawnSync(process.execPath, [npmCli, '--version'], { shell: false, encoding: 'utf8', timeout: 30_000 });
  if (npm.error || npm.status !== 0 || npm.stdout.trim() !== inventory.npm[0].version) throw new Error('npm does not match mise lock');
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  if (pkg.engines?.node || pkg.packageManager || lock.packages[''].engines?.node || lock.packages[''].packageManager) {
    throw new Error('Steward tool versions belong only to mise');
  }
  return inventory;
}
