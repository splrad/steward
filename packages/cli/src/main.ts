import { readFile } from 'node:fs/promises';
import { createGitHubRestTransport } from '../../github/src/index.js';
import { runAppInstallationPreflight, type AppInstallationReport } from './app-installation.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import { createInitPlan, parseInitSpec, type InitPlan } from './init.js';

interface DoctorArguments {
  command: 'doctor';
  repository: string;
  pullRequest?: number;
  json: boolean;
}

interface InitDryRunArguments {
  command: 'init';
  mode: 'dry-run';
  dryRun: true;
  spec: string;
  target: string;
  json: boolean;
}

interface InitPreflightArguments {
  command: 'init';
  mode: 'preflight';
  preflight: true;
  spec: string;
  repository: string;
  json: boolean;
}

type Arguments = DoctorArguments | InitDryRunArguments | InitPreflightArguments;

function usage(): string {
  return [
    'Usage:',
    '  steward doctor --repo OWNER/REPOSITORY [--pr NUMBER] [--json]',
    '  steward init --dry-run --spec FILE [--target DIRECTORY] [--json]',
    '  steward init --preflight --repo OWNER/REPOSITORY --spec FILE [--json]',
  ].join('\n');
}

function optionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value\n${usage()}`);
  return value;
}

export function parseArguments(argv: readonly string[]): Arguments {
  if (argv[0] === 'init') {
    let dryRun = false;
    let preflight = false;
    let spec = '';
    let target = '.';
    let targetSpecified = false;
    let repository = '';
    let json = false;
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === '--dry-run') dryRun = true;
      else if (argument === '--preflight') preflight = true;
      else if (argument === '--json') json = true;
      else if (argument === '--spec') spec = optionValue(argv, index++, '--spec');
      else if (argument === '--target') {
        target = optionValue(argv, index++, '--target');
        targetSpecified = true;
      } else if (argument === '--repo') repository = optionValue(argv, index++, '--repo');
      else throw new Error(`Unknown argument: ${argument ?? ''}\n${usage()}`);
    }
    if (!spec) throw new Error(`init requires --spec FILE\n${usage()}`);
    if (dryRun === preflight) throw new Error('init requires exactly one of --dry-run or --preflight');
    if (dryRun) {
      if (repository) throw new Error('--repo is only valid with init --preflight');
      if (!target) throw new Error('--target must not be empty');
      return { command: 'init', mode: 'dry-run', dryRun: true, spec, target, json };
    }
    if (targetSpecified) throw new Error('--target is only valid with init --dry-run');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`--repo must be OWNER/REPOSITORY\n${usage()}`);
    }
    return { command: 'init', mode: 'preflight', preflight: true, spec, repository, json };
  }
  if (argv[0] !== 'doctor') throw new Error(usage());
  let repository = '';
  let pullRequest: number | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument === '--repo') repository = optionValue(argv, index++, '--repo');
    else if (argument === '--pr') {
      const value = Number(optionValue(argv, index++, '--pr'));
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('--pr must be a positive integer');
      pullRequest = value;
    } else throw new Error(`Unknown argument: ${argument ?? ''}\n${usage()}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`--repo must be OWNER/REPOSITORY\n${usage()}`);
  return { command: 'doctor', repository, ...(pullRequest === undefined ? {} : { pullRequest }), json };
}

function render(report: DoctorReport): string {
  const lines = [`Steward doctor: ${report.repository}`];
  for (const item of report.findings) {
    lines.push(`[${item.level.toUpperCase()}] ${item.code}: ${item.summary}`);
    if (item.remedy) lines.push(`  修复：${item.remedy}`);
  }
  lines.push(`Summary: ${report.counts.pass} pass, ${report.counts.warning} warning, ${report.counts.fail} fail`);
  return lines.join('\n');
}

function renderInit(plan: InitPlan): string {
  const lines = [`Steward init dry-run: ${plan.targetDirectory}`, `Steward SHA: ${plan.stewardSha}`];
  for (const file of plan.files) lines.push(`[${file.status.toUpperCase()}] ${file.path} ${file.digest.slice(0, 12)}…`);
  lines.push(`Summary: ${plan.counts.create} create, ${plan.counts.unchanged} unchanged, ${plan.counts.conflict} conflict`);
  return lines.join('\n');
}

function renderAppPreflight(report: AppInstallationReport): string {
  const level = report.status === 'installed' ? 'PASS' : report.status === 'action-required' ? 'STOP' : 'UNKNOWN';
  const lines = [`Steward init preflight: ${report.repository}`, `[${level}] ${report.summary}`];
  if (report.actionUrl) lines.push(`Action: ${report.actionUrl}`);
  return lines.join('\n');
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  runtime: { templateDirectory: string },
): Promise<number> {
  try {
    const args = parseArguments(argv);
    if (args.command === 'init') {
      const raw = JSON.parse(await readFile(args.spec, 'utf8')) as unknown;
      const spec = parseInitSpec(raw);
      if (args.mode === 'dry-run') {
        const plan = await createInitPlan({
          spec,
          targetDirectory: args.target,
          templateDirectory: runtime.templateDirectory,
        });
        process.stdout.write(`${args.json ? JSON.stringify(plan, null, 2) : renderInit(plan)}\n`);
        return plan.ok ? 0 : 1;
      }
      const token = String(env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '').trim();
      if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required for init --preflight');
      const [owner, repository] = args.repository.split('/') as [string, string];
      const preflight = await runAppInstallationPreflight(
        createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' }),
        { owner, repository, manifest: spec.manifest },
      );
      process.stdout.write(`${args.json ? JSON.stringify(preflight, null, 2) : renderAppPreflight(preflight)}\n`);
      return preflight.status === 'installed' ? 0 : preflight.status === 'action-required' ? 1 : 2;
    }
    const token = String(env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '').trim();
    if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
    const [owner, repository] = args.repository.split('/') as [string, string];
    const report = await runDoctor(createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' }), {
      owner, repository, ...(args.pullRequest === undefined ? {} : { pullRequest: args.pullRequest }),
    });
    process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : render(report)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`steward: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
