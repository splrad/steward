import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  parseReleaseAdapterContext,
  parseReleaseAssetsManifest,
  parseReleasePlan,
  type ReleaseAssetsManifest,
  type ReleaseOutputFile,
  type ReleasePlan,
} from '../../packages/core/src/index.js';

export interface ReleaseAdapterExecutionInputs {
  adapterCommand: string;
  context: string;
  workspace: string;
  temporaryDirectory: string;
}

export interface ReleaseAdapterBuildResult {
  assets: ReleaseAssetsManifest;
  outputDirectory: string;
}

export type ReleaseAdapterPhase = 'plan' | 'build';

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must be valid JSON: ${detail}`);
  }
}

export function parseReleaseAdapterCommand(value: string): string[] {
  const parsed = parseJson(value, 'release-adapter-command');
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('release-adapter-command must be a non-empty JSON string array');
  }
  return parsed.map((part, index) => {
    if (typeof part !== 'string' || !part.trim() || part !== part.trim() || /[\0\r\n]/.test(part)) {
      throw new Error(`release-adapter-command[${index}] must be a non-empty single-line string without surrounding whitespace`);
    }
    return part;
  });
}

export function parseReleaseAdapterPhase(value: string | undefined): ReleaseAdapterPhase {
  const phase = value?.trim();
  if (phase === 'plan' || phase === 'build') return phase;
  throw new Error('release-adapter-phase must be plan or build');
}

async function runCommand(command: readonly string[], args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), ...args], {
      cwd,
      env: process.env,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Release adapter exited unsuccessfully (${signal ? `signal ${signal}` : `code ${String(code)}`})`));
    });
  });
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inventory(root: string, relative = ''): Promise<ReleaseOutputFile[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const result: ReleaseOutputFile[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const child = path.join(relative, entry.name);
    const fullPath = path.join(root, child);
    const stats = await lstat(fullPath);
    const portablePath = child.replaceAll('\\', '/');
    if (stats.isSymbolicLink()) {
      result.push({ path: portablePath, type: 'symlink', size: stats.size });
    } else if (stats.isDirectory()) {
      result.push({ path: portablePath, type: 'directory', size: stats.size });
      result.push(...await inventory(root, child));
    } else if (stats.isFile()) {
      result.push({ path: portablePath, type: 'file', size: stats.size, sha256: await sha256(fullPath) });
    } else {
      result.push({ path: portablePath, type: 'symlink', size: stats.size });
    }
  }
  return result;
}

async function readJsonFile(file: string, name: string): Promise<unknown> {
  try {
    return parseJson(await readFile(file, 'utf8'), name);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${name} must be valid JSON:`)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${name}: ${detail}`);
  }
}

async function executionContext(
  inputs: ReleaseAdapterExecutionInputs,
): Promise<{ command: string[]; workspace: string; executionRoot: string }> {
  const command = parseReleaseAdapterCommand(inputs.adapterCommand);
  const context = parseReleaseAdapterContext(parseJson(inputs.context, 'release-context'));
  const workspace = await realpath(inputs.workspace);
  const workspaceStats = await lstat(workspace);
  if (!workspaceStats.isDirectory()) throw new Error('release-workspace must be a directory');
  const temporaryDirectory = await realpath(inputs.temporaryDirectory);
  const temporaryStats = await lstat(temporaryDirectory);
  if (!temporaryStats.isDirectory()) throw new Error('RUNNER_TEMP must be a directory');

  const executionRoot = await mkdtemp(path.join(temporaryDirectory, 'steward-release-'));
  const contextPath = path.join(executionRoot, 'context.json');
  await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { command, workspace, executionRoot };
}

export async function executeReleasePlan(inputs: ReleaseAdapterExecutionInputs): Promise<ReleasePlan> {
  const { command, workspace, executionRoot } = await executionContext(inputs);
  const contextPath = path.join(executionRoot, 'context.json');
  const planPath = path.join(executionRoot, 'plan.json');
  await runCommand(command, ['plan', '--context', contextPath, '--output', planPath], workspace);
  const plan = parseReleasePlan(await readJsonFile(planPath, 'release plan'));
  return plan;
}

export async function executeReleaseBuild(inputs: ReleaseAdapterExecutionInputs): Promise<ReleaseAdapterBuildResult> {
  const { command, workspace, executionRoot } = await executionContext(inputs);
  const contextPath = path.join(executionRoot, 'context.json');
  const manifestPath = path.join(executionRoot, 'assets.json');
  const outputDirectory = path.join(executionRoot, 'output');
  await mkdir(outputDirectory);
  const expectedOutputDirectory = await realpath(outputDirectory);
  await runCommand(command, [
    'build', '--context', contextPath, '--output-dir', outputDirectory, '--manifest', manifestPath,
  ], workspace);
  const outputStats = await lstat(outputDirectory);
  if (!outputStats.isDirectory() || await realpath(outputDirectory) !== expectedOutputDirectory) {
    throw new Error('Release adapter replaced or redirected the isolated output directory');
  }
  const assets = parseReleaseAssetsManifest(
    await readJsonFile(manifestPath, 'release assets manifest'),
    await inventory(outputDirectory),
  );
  return { assets, outputDirectory };
}
