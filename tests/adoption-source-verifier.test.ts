import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const verifier = fileURLToPath(new URL('../scripts/verify-adoption-profile-source.mjs', import.meta.url));
const temporaryDirectories: string[] = [];

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('adoption profile source verifier', () => {
  it('hashes immutable Git blobs instead of transformed worktree bytes', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'steward-adoption-source-'));
    temporaryDirectories.push(repository);
    expect(run('git', ['init', '-b', 'main'], repository).status).toBe(0);
    expect(run('git', ['config', 'user.name', 'Steward Test'], repository).status).toBe(0);
    expect(run('git', ['config', 'user.email', 'steward-test@example.invalid'], repository).status).toBe(0);
    expect(run('git', ['remote', 'add', 'origin', 'https://github.com/splrad/example.git'], repository).status).toBe(0);
    const legacyPath = path.join(repository, '.github', 'legacy.yml');
    await mkdir(path.dirname(legacyPath), { recursive: true });
    const committed = Buffer.from('name: legacy\nvalue: exact\n');
    await writeFile(legacyPath, committed);
    expect(run('git', ['add', '.github/legacy.yml'], repository).status).toBe(0);
    expect(run('git', ['commit', '-m', 'legacy'], repository).status).toBe(0);
    const commit = run('git', ['rev-parse', 'HEAD'], repository).stdout.trim();
    const digest = createHash('sha256').update(committed).digest('hex');
    const profilePath = path.join(repository, 'profile.json');
    await writeFile(profilePath, `${JSON.stringify({
      schemaVersion: 1,
      id: 'test-profile',
      source: { repository: 'splrad/example', commit },
      replace: { '.github/legacy.yml': digest },
      remove: {},
    })}\n`);

    await writeFile(legacyPath, 'name: legacy\r\nvalue: exact\r\n');
    const verified = run(process.execPath, [verifier, profilePath, repository], repository);
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain('Verified 1 adoption digests from Git blobs');
    expect(await readFile(legacyPath, 'utf8')).toContain('\r\n');

    const wrong = JSON.parse(await readFile(profilePath, 'utf8')) as { replace: Record<string, string> };
    wrong.replace['.github/legacy.yml'] = '0'.repeat(64);
    await writeFile(profilePath, `${JSON.stringify(wrong)}\n`);
    const rejected = run(process.execPath, [verifier, profilePath, repository], repository);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('mismatch .github/legacy.yml');
  });
});
