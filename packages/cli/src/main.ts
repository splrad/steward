import { readFile } from 'node:fs/promises';
import { createGitHubRestTransport, type GitHubTransport } from '../../github/src/index.js';
import {
  dispatchActivate,
  executeActivate,
  prepareActivate,
  type ActivateReport,
  type ActivateRulesetPlan,
} from './activate.js';
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
import {
  executeUpgrade,
  prepareUpgrade,
  type UpgradePlan,
  type UpgradeReport,
} from './upgrade.js';

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

interface ActivateArguments {
  command: 'activate';
  repository: string;
  pullRequest: number;
}

interface UpgradeArguments {
  command: 'upgrade';
  repository: string;
  targetSha: string;
}

type Arguments = DoctorArguments | InitDryRunArguments | InitPreflightArguments | InitApplyArguments | ActivateArguments | UpgradeArguments;

function usage(): string {
  return [
    'Usage:',
    '  steward doctor --repo OWNER/REPOSITORY [--pr NUMBER] [--json]',
    '  steward init --dry-run --spec FILE [--target DIRECTORY] [--json]',
    '  steward init --preflight --repo OWNER/REPOSITORY --spec FILE [--json]',
    '  steward init --apply --repo OWNER/REPOSITORY --spec FILE',
    '  steward activate --repo OWNER/REPOSITORY --pr NUMBER',
    '  steward upgrade --repo OWNER/REPOSITORY --to SHA',
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
  if (argv[0] === 'activate') {
    let repository = '';
    let pullRequest = 0;
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === '--repo') repository = optionValue(argv, index++, '--repo');
      else if (argument === '--pr') {
        pullRequest = Number(optionValue(argv, index++, '--pr'));
        if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) throw new Error('--pr must be a positive integer');
      } else throw new Error(`Unknown argument: ${argument ?? ''}\n${usage()}`);
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`--repo must be OWNER/REPOSITORY\n${usage()}`);
    }
    if (!pullRequest) throw new Error(`activate requires --pr NUMBER\n${usage()}`);
    return { command: 'activate', repository, pullRequest };
  }
  if (argv[0] === 'upgrade') {
    let repository = '';
    let targetSha = '';
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === '--repo') repository = optionValue(argv, index++, '--repo');
      else if (argument === '--to') targetSha = optionValue(argv, index++, '--to').toLowerCase();
      else throw new Error(`Unknown argument: ${argument ?? ''}\n${usage()}`);
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`--repo must be OWNER/REPOSITORY\n${usage()}`);
    }
    if (!/^[a-f0-9]{40}$/.test(targetSha)) throw new Error(`--to must be a complete 40-character commit SHA\n${usage()}`);
    return { command: 'upgrade', repository, targetSha };
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
  lines.push(`Summary: ${plan.counts.create} create, ${plan.counts.replace} replace, ${plan.counts.delete} delete, ${plan.counts.unchanged} unchanged, ${plan.counts.conflict} conflict`);
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

function renderActivatePlan(plan: ActivateRulesetPlan): string {
  return [
    `Steward activate plan: ${plan.repository}`,
    `Evidence: PR #${plan.pullRequest} @ ${plan.headSha.slice(0, 12)}…`,
    `App: ${plan.appSlug} (${plan.appId})`,
    `Ruleset: ${plan.action} ${plan.rulesetName}${plan.rulesetId ? ` (#${plan.rulesetId})` : ''}`,
    `Legacy Steward checks to remove: ${plan.removedChecks.length ? plan.removedChecks.join(', ') : 'none'}`,
    `Non-Steward required checks preserved: ${plan.preservedChecks.length ? plan.preservedChecks.join(', ') : 'none'}`,
    'All other rules, conditions, and bypass actors are preserved.',
    'No ruleset mutation has been sent.',
  ].join('\n');
}

function renderActivateReport(report: ActivateReport): string {
  return `Steward activate complete: ${report.repository}\nRuleset: ${report.rulesetName} #${report.rulesetId} (${report.action})`;
}

function renderUpgradePlan(plan: UpgradePlan): string {
  const lines = [
    `Steward upgrade plan: ${plan.repository}`,
    `Default branch: ${plan.defaultBranch}@${plan.baseSha.slice(0, 12)}…`,
    `Current pins: ${plan.currentPins.map((pin) => pin.slice(0, 12)).join(', ')}`,
    `Target Steward SHA: ${plan.targetSha}`,
    `Schema migration: v${plan.sourceSchemaVersion} -> v${plan.targetSchemaVersion}`,
  ];
  for (const file of plan.files) lines.push(`[${file.status.toUpperCase()}] ${file.path} ${file.digest.slice(0, 12)}…`);
  if (plan.preservedAdapter) {
    lines.push(`Preserved adapter: ${plan.preservedAdapter.path} ${plan.preservedAdapter.digest.slice(0, 12)}…`);
  }
  lines.push(`Summary: ${plan.counts.create} create, ${plan.counts.update} update, ${plan.counts.unchanged} unchanged`);
  lines.push(`Branch: ${plan.branchStatus} ${plan.branchName}`);
  lines.push(`Pull request: ${plan.pullRequestStatus}${plan.pullRequestNumber ? ` #${plan.pullRequestNumber}` : ''}`);
  lines.push('No mutations have been sent.');
  return lines.join('\n');
}

function renderUpgradeReport(report: UpgradeReport): string {
  return [
    `Steward upgrade complete: ${report.repository}`,
    `Target: ${report.targetSha}`,
    `Branch: ${report.branchName}@${report.branchSha.slice(0, 12)}… (${report.branchStatus})`,
    `Pull request: ${report.pullRequestUrl} (${report.pullRequestStatus})`,
  ].join('\n');
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
    if (args.command === 'activate') {
      const transport = runtime.transport ?? createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' });
      const prepared = await prepareActivate(transport, {
        owner, repository, pullRequest: args.pullRequest,
      });
      if (prepared.status === 'dispatch-required') {
        await dispatchActivate(transport, prepared.plan);
        process.stdout.write([
          `Steward activate dispatched full Matrix validation for ${prepared.plan.repository} PR #${prepared.plan.pullRequest}.`,
          'Wait for the App Matrix Check to appear, then run the same activate command again.',
          'No ruleset mutation was sent.',
          '',
        ].join('\n'));
        return 0;
      }
      if (prepared.status === 'active') {
        process.stdout.write(`Steward activate: ${prepared.plan.repository} already requires ${prepared.plan.appSlug} PR Validation Matrix Gate.\n`);
        return 0;
      }
      process.stdout.write(`${renderActivatePlan(prepared.plan)}\n`);
      const confirmed = await (runtime.confirmation ?? new TerminalConfirmationPrompt())
        .confirm('Apply this Steward ruleset plan? [y/N] ');
      if (!confirmed) {
        process.stderr.write('Steward activate cancelled; no ruleset mutation was sent.\n');
        return 1;
      }
      const refreshed = await prepareActivate(transport, {
        owner, repository, pullRequest: args.pullRequest,
      });
      if (refreshed.status !== 'ready' || refreshed.plan.fingerprint !== prepared.plan.fingerprint) {
        throw new Error('activate plan changed after confirmation; no ruleset mutation was sent');
      }
      const report = await executeActivate(transport, refreshed.plan);
      process.stdout.write(`${renderActivateReport(report)}\n`);
      return 0;
    }
    if (args.command === 'upgrade') {
      const transport = runtime.transport ?? createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' });
      const prepared = await prepareUpgrade({
        transport, owner, repository, targetSha: args.targetSha,
      });
      if (prepared.status === 'current') {
        process.stdout.write(`Steward upgrade: ${prepared.plan.repository} is already current at ${prepared.plan.targetSha}.\n`);
        return 0;
      }
      process.stdout.write(`${renderUpgradePlan(prepared.plan)}\n`);
      const confirmed = await (runtime.confirmation ?? new TerminalConfirmationPrompt())
        .confirm('Create this Steward upgrade pull request? [y/N] ');
      if (!confirmed) {
        process.stderr.write('Steward upgrade cancelled; no mutations were sent.\n');
        return 1;
      }
      const refreshed = await prepareUpgrade({
        transport, owner, repository, targetSha: args.targetSha,
      });
      if (refreshed.status !== 'ready' || refreshed.plan.fingerprint !== prepared.plan.fingerprint) {
        throw new Error('upgrade plan changed after confirmation; no mutations were sent');
      }
      const report = await executeUpgrade({ transport, owner, repository, plan: refreshed.plan });
      process.stdout.write(`${renderUpgradeReport(report)}\n`);
      return 0;
    }
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
