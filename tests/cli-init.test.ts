import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitPlan, parseInitSpec } from '../packages/cli/src/init.js';
import { parseArguments } from '../packages/cli/src/main.js';
import type { ClassificationConfiguration, StewardManifest } from '../packages/manifest/src/index.js';

const stewardSha = 'a'.repeat(40);
const templateDirectory = fileURLToPath(new URL('../templates/', import.meta.url));
const temporaryDirectories: string[] = [];
const classification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

function manifest(): StewardManifest {
  return {
    schemaVersion: 1,
    automation: {
      githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
      maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
      language: 'zh-CN',
    },
    features: {
      prAutomation: false, classification: true, dcoAdvisory: false, governance: true,
      copilotReview: true, release: true, webhookRelay: true,
    },
    classification,
    release: {
      triggerPaths: ['Version.props'],
      runner: 'ubuntu-latest',
      adapterCommand: ['node', '.github/steward/release.mjs'],
    },
  };
}

async function target(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'steward-init-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('init --dry-run', () => {
  it('accepts only the explicit local dry-run surface', () => {
    expect(parseArguments(['init', '--dry-run', '--spec', 'steward-init.json', '--target', 'consumer', '--json']))
      .toEqual({ command: 'init', dryRun: true, spec: 'steward-init.json', target: 'consumer', json: true });
    expect(() => parseArguments(['init', '--spec', 'steward-init.json'])).toThrow('requires --dry-run');
    expect(() => parseArguments(['init', '--dry-run'])).toThrow('requires --spec');
  });

  it('generates a deterministic complete plan from one non-secret spec', async () => {
    const directory = await target();
    const spec = parseInitSpec({
      stewardSha,
      manifest: manifest(),
      releaseAdapter: { template: 'node', path: '.github/steward/release.mjs' },
    });
    const first = await createInitPlan({ spec, targetDirectory: directory, templateDirectory });
    const second = await createInitPlan({ spec, targetDirectory: directory, templateDirectory });

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(first.counts).toEqual({ create: 8, unchanged: 0, conflict: 0 });
    expect(first.files.map(({ path: filePath, status, digest }) => ({ path: filePath, status, digest })))
      .toMatchInlineSnapshot(`
        [
          {
            "digest": "5e54c7e473646e7b15345ac8dc7749922495be1cac57135cdf3cde5e4d20911f",
            "path": ".github/dependabot.yml",
            "status": "create",
          },
          {
            "digest": "515d6d00ad5ee77bc983e97a1082fa7a0f4a371fc11c6a3e2cd3da44c599b425",
            "path": ".github/steward.json",
            "status": "create",
          },
          {
            "digest": "d51f49e00c07d3c4cf800f1d02bddd749c90d5727046c21a174ad9de8ef07799",
            "path": ".github/steward/release.mjs",
            "status": "create",
          },
          {
            "digest": "76ff6b45113e1d93ae093f32869c7d9a93bdb89835a8f01a7a834c80b02d682e",
            "path": ".github/workflows/pr-classification.yml",
            "status": "create",
          },
          {
            "digest": "9ff70787c16120519adf1f830d25af58bc3319d5ac29e66163a8c8b80d1a14aa",
            "path": ".github/workflows/pr-governance.yml",
            "status": "create",
          },
          {
            "digest": "b6ae4decd86de7a4378e356989d0bbc82528b840140a872d0b9a8103bcbf447a",
            "path": ".github/workflows/pr-review-signal.yml",
            "status": "create",
          },
          {
            "digest": "f38de00c6099d275c5a886468f91d45fedabfda20c423fbd6cfac4360f7ae811",
            "path": ".github/workflows/pr-validation-matrix.yml",
            "status": "create",
          },
          {
            "digest": "94dd759148f9b9fffe64c984664c08fee56aa6b646b91e6a105168b41a629339",
            "path": ".github/workflows/release.yml",
            "status": "create",
          },
        ]
      `);
    expect(first.files.map((file) => file.path)).toEqual([
      '.github/dependabot.yml',
      '.github/steward.json',
      '.github/steward/release.mjs',
      '.github/workflows/pr-classification.yml',
      '.github/workflows/pr-governance.yml',
      '.github/workflows/pr-review-signal.yml',
      '.github/workflows/pr-validation-matrix.yml',
      '.github/workflows/release.yml',
    ]);
    expect(first.files.find((file) => file.path === '.github/steward.json')?.content)
      .toContain(`https://raw.githubusercontent.com/splrad/steward/${stewardSha}/schema/steward.schema.json`);
    for (const workflow of first.files.filter((file) => file.path.startsWith('.github/workflows/'))) {
      expect(workflow.content).toContain(`@${stewardSha}`);
      expect(workflow.content).not.toContain('__STEWARD_SHA__');
    }
    expect(first.files.find((file) => file.path === '.github/steward/release.mjs')?.content)
      .toContain('not implemented');
    expect(await readdir(directory)).toEqual([]);
  });

  it('reports byte-identical existing files as unchanged', async () => {
    const directory = await target();
    const minimal = manifest();
    minimal.features = {
      prAutomation: false, classification: false, dcoAdvisory: false, governance: false,
      copilotReview: false, release: false, webhookRelay: false,
    };
    delete minimal.classification;
    delete minimal.release;
    const spec = parseInitSpec({ stewardSha, manifest: minimal });
    const first = await createInitPlan({ spec, targetDirectory: directory, templateDirectory });
    for (const file of first.files) {
      const destination = path.join(directory, ...file.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content, 'utf8');
    }

    const second = await createInitPlan({ spec, targetDirectory: directory, templateDirectory });
    expect(second.ok).toBe(true);
    expect(second.counts).toEqual({ create: 0, unchanged: 2, conflict: 0 });
    expect(second.files.every((file) => file.status === 'unchanged')).toBe(true);
  });

  it('reports different existing files as conflicts without modifying the target', async () => {
    const directory = await target();
    const manifestPath = path.join(directory, '.github/steward.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, '{"ownedBy":"consumer"}\n', 'utf8');
    const before = await readFile(manifestPath, 'utf8');
    const minimal = manifest();
    minimal.features = {
      prAutomation: false, classification: false, dcoAdvisory: false, governance: false,
      copilotReview: false, release: false, webhookRelay: false,
    };
    delete minimal.classification;
    delete minimal.release;
    const plan = await createInitPlan({
      spec: parseInitSpec({ stewardSha, manifest: minimal }),
      targetDirectory: directory,
      templateDirectory,
    });

    expect(plan.ok).toBe(false);
    expect(plan.files.find((file) => file.path === '.github/steward.json')).toMatchObject({ status: 'conflict' });
    expect(await readFile(manifestPath, 'utf8')).toBe(before);
    expect(await readdir(path.join(directory, '.github'))).toEqual(['steward.json']);
  });

  it('rejects hidden fields and inconsistent release generation inputs', () => {
    expect(() => parseInitSpec({ stewardSha, manifest: manifest(), secret: 'must-not-exist' }))
      .toThrow('unknown properties: secret');
    expect(() => parseInitSpec({ stewardSha, manifest: manifest() })).toThrow('requires releaseAdapter');
    expect(() => parseInitSpec({
      stewardSha,
      manifest: manifest(),
      releaseAdapter: { template: 'node', path: '../release.mjs' },
    })).toThrow('safe POSIX');
    expect(() => parseInitSpec({
      stewardSha: 'main', manifest: manifest(), releaseAdapter: { template: 'node', path: '.github/steward/release.mjs' },
    })).toThrow('40-character');
  });
});
