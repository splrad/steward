import { readFile } from 'node:fs/promises';
import { createGitHubRestTransport, type GitHubTransport } from '../../github/src/index.js';
import { runAppInstallationPreflight, type AppInstallationReport } from './app-installation.js';
import { TerminalConfirmationPrompt, type ConfirmationPrompt } from './confirmation.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import {
  executeInitApply,
  prepareInitApply,
  type InitApplyPlan,
  type InitApplyReport,
} from './init-apply.js';
import { createInitPlan, parseInitSpec, type InitPlan } from './init.js';
import {
  redactSensitiveText,
  requiredSecretRequirements,
  TerminalSecretPrompt,
  withSecrets,
  type SecretPrompt,
} from './secret-input.js';

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

interface InitApplyArguments {
  command: 'init';
  mode: 'apply';
  apply: true;
  spec: string;
  repository: string;
}

type Arguments = DoctorArguments | InitDryRunArguments | InitPreflightArguments | InitApplyArguments;

function usage(): string {
  return [
    'Usage:',
    '  steward doctor --repo OWNER/REPOSITORY [--pr NUMBER] [--json]',
    '  steward init --dry-run --spec FILE [--target DIRECTORY] [--json]',
    '  steward init --preflight --repo OWNER/REPOSITORY --spec FILE [--json]',
    '  steward init --apply --repo OWNER/REPOSITORY --spec FILE',
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
    let apply = false;
    let spec = '';
    let target = '.';
    let targetSpecified = false;
    let repository = '';
    let json = false;
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === '--dry-run') dryRun = true;
      else if (argument === '--preflight') preflight = true;
      else if (argument === '--apply') apply = true;
      else if (argument === '--json') json = true;
      else if (argument === '--spec') spec = optionValue(argv, index++, '--spec');
      else if (argument === '--target') {
        target = optionValue(argv, index++, '--target');
        targetSpecified = true;
      } else if (argument === '--repo') repository = optionValue(argv, index++, '--repo');
      else throw new Error(`Unknown argument: ${argument ?? ''}\n${usage()}`);
    }
    if (!spec) throw new Error(`init requires --spec FILE\n${usage()}`);
    if (Number(dryRun) + Number(preflight) + Number(apply) !== 1) {
      throw new Error('init requires exactly one of --dry-run, --preflight, or --apply');
    }
    if (dryRun) {
      if (repository) throw new Error('--repo is only valid with init --preflight or init --apply');
      if (!target) throw new Error('--target must not be empty');
      return { command: 'init', mode: 'dry-run', dryRun: true, spec, target, json };
    }
    if (targetSpecified) throw new Error('--target is only valid with init --dry-run');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`--repo must be OWNER/REPOSITORY\n${usage()}`);
    }
    if (apply) {
      if (json) throw new Error('--json is not supported with interactive init --apply');
      return { command: 'init', mode: 'apply', apply: true, spec, repository };
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

function renderAppPreflight(report: AppInstallationReport, command = 'init preflight'): string {
  const level = report.status === 'installed' ? 'PASS' : report.status === 'action-required' ? 'STOP' : 'UNKNOWN';
  const lines = [`Steward ${command}: ${report.repository}`, `[${level}] ${report.summary}`];
  if (report.actionUrl) lines.push(`Action: ${report.actionUrl}`);
  return lines.join('\n');
}

function renderInitApplyPlan(plan: InitApplyPlan): string {
  const lines = [
    `Steward init apply plan: ${plan.repository}`,
    `Default branch: ${plan.defaultBranch}@${plan.baseSha.slice(0, 12)}…`,
  ];
  for (const file of plan.files) lines.push(`[${file.status.toUpperCase()}] ${file.path} ${file.digest.slice(0, 12)}…`);
  lines.push(`Secrets to create: ${plan.missingSecrets.length ? plan.missingSecrets.join(', ') : 'none'}`);
  lines.push(`Variable ${plan.variableStatus}: WORKFLOW_AUTOMATION_APP_CLIENT_ID`);
  lines.push(`Branch ${plan.branchStatus}: ${plan.branchStatus === 'none' ? 'none' : plan.branchName}`);
  lines.push(`Pull request: ${plan.pullRequestStatus}${plan.pullRequestNumber ? ` #${plan.pullRequestNumber}` : ''}`);
  lines.push('No mutations have been sent.');
  return lines.join('\n');
}

function renderInitApplyReport(report: InitApplyReport): string {
  const lines = [`Steward init apply complete: ${report.repository}`];
  if (report.branchName) lines.push(`Branch: ${report.branchName}@${report.branchSha?.slice(0, 12) ?? 'unknown'}… (${report.branchStatus})`);
  lines.push(`Secrets created: ${report.secretsCreated.length ? report.secretsCreated.join(', ') : 'none'}`);
  lines.push(`Variable created: ${report.variableCreated ? 'yes' : 'no'}`);
  if (report.pullRequestUrl) lines.push(`Pull request: ${report.pullRequestUrl} (${report.pullRequestStatus})`);
  else lines.push('Pull request: none');
  return lines.join('\n');
}

interface CliRuntime {
  templateDirectory: string;
  confirmation?: ConfirmationPrompt;
  secretPrompt?: SecretPrompt;
  transport?: GitHubTransport;
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  runtime: CliRuntime,
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
      if (!token) throw new Error(`GH_TOKEN or GITHUB_TOKEN is required for init --${args.mode}`);
      const [owner, repository] = args.repository.split('/') as [string, string];
      if (args.mode === 'apply') {
        const transport = runtime.transport ?? createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' });
        const prepared = await prepareInitApply({
          transport, owner, repository, spec, templateDirectory: runtime.templateDirectory,
        });
        if (prepared.status === 'blocked') {
          process.stdout.write(`${renderAppPreflight(prepared.preflight, 'init apply preflight')}\n`);
          return prepared.preflight.status === 'action-required' ? 1 : 2;
        }
        process.stdout.write(`${renderInitApplyPlan(prepared.plan)}\n`);
        const confirmed = await (runtime.confirmation ?? new TerminalConfirmationPrompt()).confirm();
        if (!confirmed) {
          process.stderr.write('Steward init cancelled; no mutations were sent.\n');
          return 1;
        }
        const requirements = requiredSecretRequirements(spec.manifest)
          .filter((requirement) => prepared.plan.missingSecrets.includes(requirement.name));
        return await withSecrets(requirements, runtime.secretPrompt ?? new TerminalSecretPrompt(), async (vault) => {
          const refreshed = await prepareInitApply({
            transport, owner, repository, spec, templateDirectory: runtime.templateDirectory,
          });
          if (refreshed.status !== 'ready' || refreshed.plan.fingerprint !== prepared.plan.fingerprint) {
            throw new Error('init --apply plan changed after confirmation; no mutations were sent');
          }
          const report = await executeInitApply({ transport, owner, repository, plan: refreshed.plan, vault });
          process.stdout.write(`${renderInitApplyReport(report)}\n`);
          return 0;
        });
      }
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
    process.stderr.write(`steward: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }
}
