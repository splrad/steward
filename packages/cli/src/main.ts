import { open, readFile } from 'node:fs/promises';
import {
  createGitHubRestTransport,
  type GitHubActionsExecutionProtections,
  type GitHubReadResult,
  type GitHubTransport,
} from '../../github/src/index.js';
import { runAppInstallationPreflight, type AppInstallationReport } from './app-installation.js';
import { verifyActionsExecutionProtectionAttestation } from './actions-attestation.js';
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
  createAuthenticatedRuntimeDiagnosticsProvider,
  type RuntimeDiagnosticsProvider,
} from './runtime-diagnostics.js';
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
  actionsAttestation?: string;
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

interface UpgradeArguments {
  command: 'upgrade';
  repository: string;
  targetSha: string;
}

type Arguments = DoctorArguments | InitDryRunArguments | InitPreflightArguments | InitApplyArguments | UpgradeArguments;

function usage(): string {
  return [
    'Usage:',
    '  steward doctor --repo OWNER/REPOSITORY [--pr NUMBER] [--actions-attestation FILE] [--json]',
    '  steward init --dry-run --spec FILE [--target DIRECTORY] [--json]',
    '  steward init --preflight --repo OWNER/REPOSITORY --spec FILE [--json]',
    '  steward init --apply --repo OWNER/REPOSITORY --spec FILE',
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
  let actionsAttestation: string | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument === '--repo') repository = optionValue(argv, index++, '--repo');
    else if (argument === '--actions-attestation') {
      actionsAttestation = optionValue(argv, index++, '--actions-attestation');
    }
    else if (argument === '--pr') {
      const value = Number(optionValue(argv, index++, '--pr'));
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('--pr must be a positive integer');
      pullRequest = value;
    } else throw new Error(`Unknown argument: ${argument ?? ''}\n${usage()}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`--repo must be OWNER/REPOSITORY\n${usage()}`);
  return {
    command: 'doctor',
    repository,
    ...(pullRequest === undefined ? {} : { pullRequest }),
    ...(actionsAttestation === undefined ? {} : { actionsAttestation }),
    json,
  };
}

function render(report: DoctorReport): string {
  const lines = [`Steward doctor: ${report.repository}`, `Status: ${report.status}`];
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
  organizationTransport?: GitHubTransport;
  organizationRulesetTransport?: GitHubTransport;
  installationTransport?: GitHubTransport;
  appJwtTransport?: GitHubTransport;
  runtimeDiagnostics?: RuntimeDiagnosticsProvider;
  actionsExecutionProtections?: GitHubReadResult<GitHubActionsExecutionProtections>;
}

export const MAX_ACTIONS_ATTESTATION_BYTES = 128 * 1024;

export interface ActionsAttestationReadHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export type OpenActionsAttestationFile = (
  path: string,
  flags: 'r',
) => Promise<ActionsAttestationReadHandle>;

export async function readActionsAttestationFile(
  path: string,
  openFile: OpenActionsAttestationFile = open,
): Promise<unknown> {
  const file = await openFile(path, 'r');
  let body: Buffer;
  try {
    const buffer = Buffer.alloc(MAX_ACTIONS_ATTESTATION_BYTES + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.byteLength) {
      const { bytesRead } = await file.read(
        buffer,
        totalBytesRead,
        buffer.byteLength - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    if (totalBytesRead > MAX_ACTIONS_ATTESTATION_BYTES) {
      throw new Error(`--actions-attestation exceeds ${MAX_ACTIONS_ATTESTATION_BYTES} bytes`);
    }
    body = buffer.subarray(0, totalBytesRead);
  } finally {
    await file.close();
  }
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    // The verifier converts malformed owner input to an unknown fact instead
    // of letting invalid JSON bypass the rest of the read-only Doctor report.
    return body.toString('utf8');
  }
}

function doctorOrganizationTransport(
  env: NodeJS.ProcessEnv,
  runtime: CliRuntime,
): GitHubTransport | undefined {
  if (runtime.organizationTransport) return runtime.organizationTransport;
  const token = String(env.STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN ?? '').trim();
  return token
    ? createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli-org-diagnostics' })
    : undefined;
}

function doctorOrganizationRulesetTransport(
  env: NodeJS.ProcessEnv,
  runtime: CliRuntime,
): GitHubTransport | undefined {
  if (runtime.organizationRulesetTransport) return runtime.organizationRulesetTransport;
  const token = String(env.STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN ?? '').trim();
  return token
    ? createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli-org-ruleset-diagnostics' })
    : undefined;
}

function assertDoctorCredentialSeparation(
  env: NodeJS.ProcessEnv,
  runtime: CliRuntime,
): void {
  const credentialRoles = [
    {
      name: 'GH_TOKEN and GITHUB_TOKEN',
      values: runtime.transport
        ? []
        : [
          String(env.GH_TOKEN ?? '').trim(),
          String(env.GITHUB_TOKEN ?? '').trim(),
        ].filter(Boolean),
    },
    {
      name: 'STEWARD_APP_USER_TOKEN',
      values: runtime.installationTransport
        ? []
        : [String(env.STEWARD_APP_USER_TOKEN ?? '').trim()].filter(Boolean),
    },
    {
      name: 'STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN',
      values: runtime.organizationTransport
        ? []
        : [String(env.STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN ?? '').trim()].filter(Boolean),
    },
    {
      name: 'STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN',
      values: runtime.organizationRulesetTransport
        ? []
        : [String(env.STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN ?? '').trim()].filter(Boolean),
    },
    {
      name: 'STEWARD_RUNTIME_DIAGNOSTICS_ACCESS_CLIENT_SECRET',
      values: runtime.runtimeDiagnostics
        ? []
        : [String(env.STEWARD_RUNTIME_DIAGNOSTICS_ACCESS_CLIENT_SECRET ?? '').trim()]
          .filter(Boolean),
    },
  ] as const;

  for (let left = 0; left < credentialRoles.length; left += 1) {
    const leftRole = credentialRoles[left]!;
    for (let right = left + 1; right < credentialRoles.length; right += 1) {
      const rightRole = credentialRoles[right]!;
      if (leftRole.values.some((value) => rightRole.values.includes(value))) {
        throw new Error(
          `${rightRole.name} must use a credential distinct from ${leftRole.name}`,
        );
      }
    }
  }
}

function installationProofTransport(
  env: NodeJS.ProcessEnv,
  runtime: CliRuntime,
  fallback: GitHubTransport,
): GitHubTransport {
  const token = String(env.STEWARD_APP_USER_TOKEN ?? '').trim();
  return runtime.installationTransport ?? (token
    ? createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' })
    : fallback);
}

function doctorAppUserTransport(
  env: NodeJS.ProcessEnv,
  runtime: CliRuntime,
): GitHubTransport | undefined {
  if (runtime.installationTransport) return runtime.installationTransport;
  const token = String(env.STEWARD_APP_USER_TOKEN ?? '').trim();
  return token
    ? createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' })
    : undefined;
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
      const [owner, repository] = args.repository.split('/') as [string, string];
      if (args.mode === 'apply') {
        const token = String(env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '').trim();
        if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required for init --apply mutations');
        const transport = runtime.transport ?? createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' });
        const installationTransport = installationProofTransport(env, runtime, transport);
        const prepared = await prepareInitApply({
          transport, installationTransport, owner, repository, spec, templateDirectory: runtime.templateDirectory,
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
            transport, installationTransport, owner, repository, spec, templateDirectory: runtime.templateDirectory,
          });
          if (refreshed.status !== 'ready' || refreshed.plan.fingerprint !== prepared.plan.fingerprint) {
            throw new Error('init --apply plan changed after confirmation; no mutations were sent');
          }
          const report = await executeInitApply({ transport, owner, repository, plan: refreshed.plan, vault });
          process.stdout.write(`${renderInitApplyReport(report)}\n`);
          return 0;
        });
      }
      const token = String(env.STEWARD_APP_USER_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '').trim();
      if (!token) {
        throw new Error('STEWARD_APP_USER_TOKEN, GH_TOKEN, or GITHUB_TOKEN is required for init --preflight');
      }
      const transport = runtime.transport ?? createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' });
      const preflight = await runAppInstallationPreflight(
        installationProofTransport(env, runtime, transport),
        { owner, repository, manifest: spec.manifest },
      );
      process.stdout.write(`${args.json ? JSON.stringify(preflight, null, 2) : renderAppPreflight(preflight)}\n`);
      return preflight.status === 'installed' ? 0 : preflight.status === 'action-required' ? 1 : 2;
    }
    const token = String(env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '').trim();
    const [owner, repository] = args.repository.split('/') as [string, string];
    if (args.command === 'upgrade') {
      if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
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
    if (!token && !runtime.transport) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
    const runtimeDiagnostics = runtime.runtimeDiagnostics
      ?? createAuthenticatedRuntimeDiagnosticsProvider(env);
    assertDoctorCredentialSeparation(env, runtime);
    const transport = runtime.transport ?? createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' });
    const organizationTransport = doctorOrganizationTransport(env, runtime);
    const organizationRulesetTransport = doctorOrganizationRulesetTransport(env, runtime);
    const appUserTransport = doctorAppUserTransport(env, runtime);
    if (args.actionsAttestation && runtime.actionsExecutionProtections) {
      throw new Error('--actions-attestation cannot be combined with an injected Actions observation');
    }
    if (args.actionsAttestation && !organizationTransport) {
      throw new Error(
        'STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN or an injected organization transport is required for --actions-attestation',
      );
    }
    const actionsExecutionProtections = args.actionsAttestation
      ? await verifyActionsExecutionProtectionAttestation(
        await readActionsAttestationFile(args.actionsAttestation),
        organizationTransport!,
      )
      : runtime.actionsExecutionProtections;
    const report = await runDoctor({
      repositoryTransport: transport,
      ...(organizationTransport ? { organizationTransport } : {}),
      ...(organizationRulesetTransport ? { organizationRulesetTransport } : {}),
      ...(runtime.appJwtTransport ? { appJwtTransport: runtime.appJwtTransport } : {}),
      ...(appUserTransport ? { appUserTransport } : {}),
      ...(runtimeDiagnostics ? { runtimeDiagnostics } : {}),
      ...(actionsExecutionProtections
        ? { actionsExecutionProtections }
        : {}),
    }, {
      owner, repository, ...(args.pullRequest === undefined ? {} : { pullRequest: args.pullRequest }),
    });
    process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : render(report)}\n`);
    return report.status === 'ready' ? 0 : report.status === 'action-required' ? 1 : 2;
  } catch (error) {
    process.stderr.write(`steward: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }
}
