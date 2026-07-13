import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function usage() {
  return 'Usage: node scripts/verify-adoption-profile-source.mjs PROFILE_JSON SOURCE_REPOSITORY';
}

function git(repository, args) {
  const result = spawnSync('git', ['-c', `safe.directory=${repository}`, ...args], {
    cwd: repository,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(Buffer.from(result.stderr ?? []).toString('utf8').trim() || `git ${args[0]} failed`);
  }
  return Buffer.from(result.stdout ?? []);
}

function canonicalRemote(value) {
  const candidate = value.trim();
  const match = candidate.match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^\s]+?)(?:\.git)?$/i);
  return match?.[1]?.toLowerCase();
}

const [profileArgument, repositoryArgument, ...extra] = process.argv.slice(2);
if (!profileArgument || !repositoryArgument || extra.length) throw new Error(usage());

const profilePath = path.resolve(profileArgument);
const repository = path.resolve(repositoryArgument);
const profile = JSON.parse(await readFile(profilePath, 'utf8'));
const expectedRepository = String(profile.source?.repository ?? '').toLowerCase();
const commit = String(profile.source?.commit ?? '');
if (!/^[^/\s]+\/[^/\s]+$/.test(expectedRepository) || !/^[a-f0-9]{40}$/.test(commit)) {
  throw new Error('Profile source repository or commit is invalid');
}
const remotes = git(repository, ['remote', '-v']).toString('utf8').split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/)[1])
  .filter((value) => value !== undefined)
  .map(canonicalRemote);
if (!remotes.includes(expectedRepository)) {
  throw new Error(`Source clone has no GitHub remote matching ${expectedRepository}`);
}

const expected = new Map([
  ...Object.entries(profile.replace ?? {}),
  ...Object.entries(profile.remove ?? {}),
]);
if (!expected.size) throw new Error('Profile has no digest entries');

const mismatches = [];
for (const [file, wanted] of expected) {
  const blob = git(repository, ['show', `${commit}:${file}`]);
  const actual = createHash('sha256').update(blob).digest('hex');
  if (actual !== wanted) mismatches.push({ file, actual, expected: wanted });
}
if (mismatches.length) {
  for (const mismatch of mismatches) {
    process.stderr.write(`mismatch ${mismatch.file}: ${mismatch.actual} != ${mismatch.expected}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Verified ${expected.size} adoption digests from Git blobs at ${expectedRepository}@${commit}.\n`);
}
