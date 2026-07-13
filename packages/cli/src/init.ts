import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeManifest, parseManifest, type StewardManifest } from '../../manifest/src/index.js';
import { loadAdoptionProfile } from './adoption.js';

export interface InitSpec {
  stewardSha: string;
  manifest: StewardManifest;
  releaseAdapter?: { template: 'node'; path: string };
  adoption?: { profile: string };
}

export type InitFileStatus = 'create' | 'replace' | 'delete' | 'unchanged' | 'conflict';
export type InitFileOperation = 'write' | 'delete';

export interface InitPlannedFile {
  path: string;
  status: InitFileStatus;
  operation: InitFileOperation;
  digest: string;
  content?: string;
  existingDigest?: string;
}

export interface InitGeneratedFile {
  path: string;
  digest: string;
  content: string;
}

export interface InitPlan {
  targetDirectory: string;
  stewardSha: string;
  files: InitPlannedFile[];
  counts: Record<InitFileStatus, number>;
  ok: boolean;
}

export interface InitFilePlan {
  files: InitPlannedFile[];
  counts: Record<InitFileStatus, number>;
}

type JsonObject = Record<string, unknown>;

const shaPattern = /^[a-f0-9]{40}$/i;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown properties: ${unknown.join(', ')}`);
}

function repositoryPath(value: unknown, label: string): string {
  const candidate = String(value ?? '');
  const parts = candidate.split('/');
  if (!candidate || candidate.startsWith('/') || candidate.endsWith('/') || candidate.includes('\\')
    || candidate.includes(':') || /[\u0000-\u001f]/.test(candidate)
    || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be a safe POSIX repository-relative path`);
  }
  return candidate;
}

export function parseInitSpec(value: unknown): InitSpec {
  const input = object(value, 'init spec');
  exactKeys(input, ['stewardSha', 'manifest', 'releaseAdapter', 'adoption'], 'init spec');
  const stewardSha = String(input.stewardSha ?? '').toLowerCase();
  if (!shaPattern.test(stewardSha)) throw new Error('init spec stewardSha must be a complete 40-character commit SHA');

  const rawManifest = structuredClone(object(input.manifest, 'init spec manifest'));
  const expectedSchema = `https://raw.githubusercontent.com/splrad/steward/${stewardSha}/schema/steward.schema.json`;
  if (rawManifest.$schema !== undefined && rawManifest.$schema !== expectedSchema) {
    throw new Error('init spec manifest $schema does not match stewardSha');
  }
  rawManifest.$schema = expectedSchema;
  const manifest = normalizeManifest(parseManifest(rawManifest));

  let releaseAdapter: InitSpec['releaseAdapter'];
  if (input.releaseAdapter !== undefined) {
    const adapter = object(input.releaseAdapter, 'init spec releaseAdapter');
    exactKeys(adapter, ['template', 'path'], 'init spec releaseAdapter');
    if (adapter.template !== 'node') throw new Error('init spec releaseAdapter.template must be node');
    const adapterPath = repositoryPath(adapter.path, 'init spec releaseAdapter.path');
    if (!adapterPath.startsWith('.github/steward/') || !adapterPath.endsWith('.mjs')) {
      throw new Error('init spec releaseAdapter.path must be an .mjs file under .github/steward/');
    }
    releaseAdapter = { template: 'node', path: adapterPath };
  }
  if (manifest.features.release) {
    if (!manifest.release || !releaseAdapter) {
      throw new Error('release-enabled init spec requires releaseAdapter');
    }
    if (JSON.stringify(manifest.release.adapterCommand) !== JSON.stringify(['node', releaseAdapter.path])) {
      throw new Error('release.adapterCommand must exactly match the generated node releaseAdapter path');
    }
  } else if (releaseAdapter) {
    throw new Error('releaseAdapter is not allowed when the release feature is disabled');
  }
  let adoption: InitSpec['adoption'];
  if (input.adoption !== undefined) {
    const configured = object(input.adoption, 'init spec adoption');
    exactKeys(configured, ['profile'], 'init spec adoption');
    const profile = String(configured.profile ?? '');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(profile)) {
      throw new Error('init spec adoption.profile must be a safe built-in profile id');
    }
    adoption = { profile };
  }
  return {
    stewardSha,
    manifest,
    ...(releaseAdapter ? { releaseAdapter } : {}),
    ...(adoption ? { adoption } : {}),
  };
}

export function workflowTemplates(manifest: StewardManifest): Array<{ template: string; destination: string }> {
  const workflows: Array<{ template: string; destination: string }> = [];
  if (manifest.features.prAutomation) {
    workflows.push({ template: 'thin-workflows/pr-automation.yml', destination: '.github/workflows/pr-automation.yml' });
  }
  if (manifest.features.classification) {
    workflows.push({ template: 'thin-workflows/pr-classification.yml', destination: '.github/workflows/pr-classification.yml' });
  }
  if (manifest.features.dcoAdvisory) {
    workflows.push({ template: 'thin-workflows/dco-advisory.yml', destination: '.github/workflows/dco-advisory.yml' });
  }
  if (manifest.features.governance || manifest.features.copilotReview) {
    workflows.push({ template: 'thin-workflows/pr-governance.yml', destination: '.github/workflows/pr-governance.yml' });
    workflows.push({ template: 'thin-workflows/pr-cleanup.yml', destination: '.github/workflows/pr-cleanup.yml' });
  }
  if (manifest.features.copilotReview) {
    workflows.push({ template: 'thin-workflows/pr-review-signal.yml', destination: '.github/workflows/pr-review-signal.yml' });
  }
  if (manifest.features.classification || manifest.features.dcoAdvisory
    || manifest.features.governance || manifest.features.copilotReview) {
    workflows.push({ template: 'thin-workflows/pr-validation-matrix.yml', destination: '.github/workflows/pr-validation-matrix.yml' });
  }
  if (manifest.features.release) {
    workflows.push({ template: 'thin-workflows/release.yml', destination: '.github/workflows/release.yml' });
  }
  return workflows;
}

export function replaceStewardSha(template: string, stewardSha: string, name: string): string {
  const marker = '__STEWARD_SHA__';
  const count = template.split(marker).length - 1;
  if (count !== 1) throw new Error(`Steward template ${name} must contain exactly one ${marker} marker`);
  return template.replace(marker, stewardSha);
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function existingContent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function emptyCounts(): Record<InitFileStatus, number> {
  return { create: 0, replace: 0, delete: 0, unchanged: 0, conflict: 0 };
}

export async function planInitFiles(input: {
  spec: InitSpec;
  templateDirectory: string;
  readExisting: (filePath: string) => Promise<string | null>;
}): Promise<InitFilePlan> {
  const generated = await generateInitFiles(input);
  const generatedByPath = new Map(generated.map((file) => [file.path, file]));
  const profile = input.spec.adoption
    ? await loadAdoptionProfile(input.templateDirectory, input.spec.adoption.profile)
    : undefined;
  if (profile) {
    const unmanaged = [...profile.replace.keys()].filter((filePath) => !generatedByPath.has(filePath));
    if (unmanaged.length) {
      throw new Error(`adoption profile replacement paths are not generated by this init spec: ${unmanaged.join(', ')}`);
    }
  }

  const files: InitPlannedFile[] = [];
  for (const file of generated) {
    const existing = await input.readExisting(file.path);
    const existingDigest = existing === null ? undefined : digest(existing);
    let status: InitFileStatus;
    if (existing === null) status = 'create';
    else if (existing === file.content) status = 'unchanged';
    else if (profile?.replace.get(file.path) === existingDigest) status = 'replace';
    else status = 'conflict';
    files.push({
      ...file,
      operation: 'write',
      status,
      ...((status === 'replace' || status === 'conflict') && existingDigest ? { existingDigest } : {}),
    });
  }
  for (const [filePath, expectedDigest] of profile?.remove ?? []) {
    const existing = await input.readExisting(filePath);
    const existingDigest = existing === null ? undefined : digest(existing);
    const status: InitFileStatus = existing === null
      ? 'unchanged'
      : existingDigest === expectedDigest ? 'delete' : 'conflict';
    files.push({
      path: filePath,
      operation: 'delete',
      status,
      digest: expectedDigest,
      ...(existingDigest ? { existingDigest } : {}),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const counts = emptyCounts();
  for (const file of files) counts[file.status] += 1;
  return { files, counts };
}

export async function createInitPlan(input: {
  spec: InitSpec;
  targetDirectory: string;
  templateDirectory: string;
}): Promise<InitPlan> {
  const targetDirectory = path.resolve(input.targetDirectory);
  const { files, counts } = await planInitFiles({
    ...input,
    readExisting: async (filePath) => {
      const destination = path.resolve(targetDirectory, ...filePath.split('/'));
      const destinationRelative = path.relative(targetDirectory, destination);
      if (!destinationRelative || destinationRelative.startsWith('..') || path.isAbsolute(destinationRelative)) {
        throw new Error(`generated path escaped target directory: ${filePath}`);
      }
      return existingContent(destination);
    },
  });
  return {
    targetDirectory,
    stewardSha: input.spec.stewardSha,
    files,
    counts,
    ok: counts.conflict === 0,
  };
}

export async function generateInitFiles(input: {
  spec: InitSpec;
  templateDirectory: string;
}): Promise<InitGeneratedFile[]> {
  const generated = new Map<string, string>();
  generated.set('.github/steward.json', `${JSON.stringify(input.spec.manifest, null, 2)}\n`);
  generated.set('.github/dependabot.yml', await readFile(path.join(input.templateDirectory, 'init/dependabot.yml'), 'utf8'));
  for (const workflow of workflowTemplates(input.spec.manifest)) {
    const template = await readFile(path.join(input.templateDirectory, workflow.template), 'utf8');
    generated.set(workflow.destination, replaceStewardSha(template, input.spec.stewardSha, workflow.template));
  }
  if (input.spec.releaseAdapter) {
    generated.set(input.spec.releaseAdapter.path, await readFile(path.join(input.templateDirectory, 'init/release-adapter.mjs'), 'utf8'));
  }

  return [...generated.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, content]) => ({ path: filePath, digest: digest(content), content }));
}
