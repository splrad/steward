import { parseStewardCheckExternalId } from '../../core/src/index.js';
import {
  GitHubApiError,
  GitHubRepositoryClient,
  type GitHubCheckRun,
  type GitHubRequest,
  type GitHubTransport,
  type GitHubWorkflowRun,
} from '../../github/src/index.js';
import {
  loadDefaultBranchManifest,
  type LoadedManifest,
  type StewardManifest,
} from '../../manifest/src/index.js';

export type DoctorLevel = 'pass' | 'warning' | 'fail';

export interface DoctorFinding {
  code: string;
  level: DoctorLevel;
  summary: string;
  remedy?: string;
}

export interface DoctorReport {
  repository: string;
  findings: DoctorFinding[];
  counts: Record<DoctorLevel, number>;
  ok: boolean;
}

export interface DoctorOptions {
  owner: string;
  repository: string;
  pullRequest?: number;
}

interface RepositoryPayload {
  id?: number;
  full_name?: string;
  default_branch?: string | null;
  owner?: { login?: string; type?: string } | null;
}

interface InstallationPayload {
  id?: number;
  app_id?: number;
  app_slug?: string;
  client_id?: string;
  repository_selection?: string;
  permissions?: Record<string, string>;
  suspended_at?: string | null;
}

interface PullPayload {
  number?: number;
  state?: string;
  base?: { ref?: string } | null;
  head?: { sha?: string } | null;
}

interface RulesetPayload {
  id?: number;
  name?: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: Array<{
    type?: string;
    parameters?: {
      required_status_checks?: Array<{ context?: string; integration_id?: number }>;
    };
  }>;
}

const matrixGateName = 'PR Validation Matrix Gate';

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function repositoryPath(owner: string, repository: string): string {
  return `/repos/${segment(owner)}/${segment(repository)}`;
}

function finding(code: string, level: DoctorLevel, summary: string, remedy?: string): DoctorFinding {
  return { code, level, summary, ...(remedy ? { remedy } : {}) };
}

function requiredWorkflowFiles(manifest: StewardManifest): Array<{ path: string; called: string }> {
  const files: Array<{ path: string; called: string }> = [];
  if (manifest.features.classification) {
    files.push({ path: '.github/workflows/pr-classification.yml', called: 'pr-classification.yml' });
  }
  if (manifest.features.governance || manifest.features.copilotReview) {
    files.push({ path: '.github/workflows/pr-governance.yml', called: 'pr-governance.yml' });
  }
  if (manifest.features.copilotReview) {
    files.push({ path: '.github/workflows/pr-review-signal.yml', called: 'pr-review-signal.yml' });
  }
  if (manifest.features.classification || manifest.features.dcoAdvisory
    || manifest.features.governance || manifest.features.copilotReview) {
    files.push({ path: '.github/workflows/pr-validation-matrix.yml', called: 'pr-validation-matrix.yml' });
  }
  if (manifest.features.release) files.push({ path: '.github/workflows/release.yml', called: 'release.yml' });
  return files;
}

function requiredSecretNames(manifest: StewardManifest): string[] {
  const names = new Set<string>();
  if (requiredWorkflowFiles(manifest).some((file) => file.called !== 'pr-review-signal.yml')) {
    names.add('WORKFLOW_AUTOMATION_APP_PRIVATE_KEY');
  }
  if (manifest.features.copilotReview) names.add('COPILOT_REVIEW_REQUEST_TOKEN');
  if (manifest.features.governance) names.add('CORE_AUTO_APPROVAL_TOKEN');
  return [...names].sort();
}

function schemaPin(manifest: StewardManifest): string {
  const match = String(manifest.$schema ?? '').match(
    /^https:\/\/raw\.githubusercontent\.com\/splrad\/steward\/([a-f0-9]{40})\/schema\/steward\.schema\.json$/i,
  );
  return match?.[1]?.toLowerCase() ?? '';
}

function workflowPin(content: string, called: string): string {
  const escaped = called.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...content.matchAll(new RegExp(
    `uses:\\s*['\"]?splrad/steward/\\.github/workflows/${escaped}@([a-f0-9]{40})['\"]?`,
    'gi',
  ))];
  return matches.length === 1 ? String(matches[0]?.[1] ?? '').toLowerCase() : '';
}

function decodeFile(payload: { type?: string; encoding?: string; content?: string }): string {
  if (payload.type !== 'file' || payload.encoding !== 'base64' || !payload.content) {
    throw new Error('GitHub returned an invalid repository file response');
  }
  return Buffer.from(payload.content.replaceAll(/\s/g, ''), 'base64').toString('utf8');
}

async function optionalRequest<T>(transport: GitHubTransport, request: GitHubRequest): Promise<T | null> {
  try {
    return await transport.request<T>(request);
  } catch (error) {
    if (error instanceof GitHubApiError && [403, 404].includes(error.status)) return null;
    throw error;
  }
}

async function optionalPagedRequest<TPayload, TItem>(
  transport: GitHubTransport,
  request: GitHubRequest,
  items: (payload: TPayload) => readonly TItem[],
): Promise<TItem[] | null> {
  const collected: TItem[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const payload = await optionalRequest<TPayload>(transport, {
      ...request,
      query: { ...request.query, page, per_page: 100 },
    });
    if (!payload) return null;
    const batch = [...items(payload)];
    collected.push(...batch);
    if (batch.length < 100) return collected;
  }
  throw new Error('GitHub diagnostic read exceeded the 20-page safety limit');
}

function installationPermissions(manifest: StewardManifest): Record<string, 'read' | 'write'> {
  const required: Record<string, 'read' | 'write'> = {
    checks: 'write',
    contents: manifest.features.release ? 'write' : 'read',
    pull_requests: 'write',
  };
  if (manifest.features.classification || manifest.features.governance || manifest.features.copilotReview) {
    required.issues = 'write';
  }
  if (manifest.features.governance && manifest.automation.maintainers.source === 'organization-team') {
    required.members = 'read';
  }
  if (manifest.features.classification || manifest.features.dcoAdvisory
    || manifest.features.governance || manifest.features.copilotReview) {
    required.actions = 'write';
  }
  return required;
}

function permissionSatisfies(actual: string | undefined, required: 'read' | 'write'): boolean {
  return actual === 'write' || (required === 'read' && actual === 'read');
}

function rulesetTargetsDefaultBranch(ruleset: RulesetPayload, defaultBranch: string): boolean {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  const exclude = ruleset.conditions?.ref_name?.exclude ?? [];
  const ref = `refs/heads/${defaultBranch}`;
  const excluded = exclude.includes('~DEFAULT_BRANCH') || exclude.includes(ref);
  return !excluded && (include.includes('~DEFAULT_BRANCH') || include.includes(ref));
}

function report(repository: string, findings: DoctorFinding[]): DoctorReport {
  const counts = { pass: 0, warning: 0, fail: 0 };
  for (const item of findings) counts[item.level] += 1;
  return { repository, findings, counts, ok: counts.fail === 0 };
}

export async function runDoctor(transport: GitHubTransport, options: DoctorOptions): Promise<DoctorReport> {
  const path = repositoryPath(options.owner, options.repository);
  const findings: DoctorFinding[] = [];
  const repository = await transport.request<RepositoryPayload>({ path });
  const repositoryId = Number(repository.id ?? 0);
  const fullName = String(repository.full_name ?? '');
  const defaultBranch = String(repository.default_branch ?? '');
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 || !fullName || !defaultBranch) {
    throw new Error('GitHub returned invalid repository metadata');
  }
  findings.push(finding('repository.default-branch', 'pass', `默认分支为 ${defaultBranch}。`));

  let loaded: LoadedManifest;
  try {
    loaded = await loadDefaultBranchManifest(new GitHubRepositoryClient(transport), options.owner, options.repository);
    findings.push(finding('manifest.valid', 'pass', `默认分支 Manifest schemaVersion=${loaded.manifest.schemaVersion}，config=${loaded.configDigest.slice(0, 12)}…。`));
  } catch (error) {
    findings.push(finding('manifest.valid', 'fail', `无法加载默认分支 Manifest：${error instanceof Error ? error.message : String(error)}`,
      '修复 .github/steward.json 并确保它符合当前 Steward Schema。'));
    return report(fullName, findings);
  }

  const pin = schemaPin(loaded.manifest);
  findings.push(pin
    ? finding('manifest.schema-pin', 'pass', `Schema 固定到完整 Steward SHA ${pin.slice(0, 12)}…。`)
    : finding('manifest.schema-pin', 'fail', 'Manifest $schema 未固定到 splrad/steward 的完整 40 位 SHA。',
      '使用固定提交的 raw.githubusercontent.com Schema URL。'));

  const [secrets, variables] = await Promise.all([
    optionalPagedRequest<{ secrets?: Array<{ name?: string }> }, { name?: string }>(
      transport, { path: `${path}/actions/secrets` }, (payload) => payload.secrets ?? [],
    ),
    optionalPagedRequest<{ variables?: Array<{ name?: string; value?: string }> }, { name?: string; value?: string }>(
      transport, { path: `${path}/actions/variables` }, (payload) => payload.variables ?? [],
    ),
  ]);
  if (!secrets) {
    findings.push(finding('actions.secrets', 'warning', '当前 token 无法读取 Actions Secret 名称。',
      '使用具有仓库管理员权限的 token 重新运行；doctor 永远不会读取 Secret 值。'));
  } else {
    const present = new Set(secrets.map((item) => String(item.name ?? '')));
    const missing = requiredSecretNames(loaded.manifest).filter((name) => !present.has(name));
    findings.push(missing.length
      ? finding('actions.secrets', 'fail', `缺少 Actions Secrets：${missing.join(', ')}。`, '安全写入缺失 Secrets 后重新运行 doctor。')
      : finding('actions.secrets', 'pass', '所有启用功能所需的 Actions Secret 名称均存在；未读取任何值。'));
  }
  if (!variables) {
    findings.push(finding('actions.variables', 'warning', '当前 token 无法读取 Actions Variables。',
      '使用具有仓库管理员权限的 token 重新运行。'));
  } else {
    const appClientId = variables.find((item) => item.name === 'WORKFLOW_AUTOMATION_APP_CLIENT_ID')?.value;
    findings.push(appClientId === loaded.manifest.automation.githubApp.clientId
      ? finding('actions.variables', 'pass', 'WORKFLOW_AUTOMATION_APP_CLIENT_ID 与 Manifest 一致。')
      : finding('actions.variables', 'fail', 'WORKFLOW_AUTOMATION_APP_CLIENT_ID 缺失或与 Manifest 不一致。',
        '将仓库 Variable 更新为 Manifest 中的 GitHub App clientId。'));
  }

  const governancePins: string[] = [];
  for (const workflow of requiredWorkflowFiles(loaded.manifest)) {
    const payload = await optionalRequest<{ type?: string; encoding?: string; content?: string }>(transport, {
      path: `${path}/contents/${workflow.path.split('/').map(segment).join('/')}`,
      query: { ref: defaultBranch },
    });
    if (!payload) {
      findings.push(finding(`workflow.${workflow.called}`, 'fail', `缺少薄 workflow ${workflow.path}。`, '从相同 Steward SHA 生成该 caller。'));
      continue;
    }
    const callerPin = workflowPin(decodeFile(payload), workflow.called);
    if (callerPin && workflow.called !== 'release.yml') governancePins.push(callerPin);
    findings.push(callerPin
      ? finding(`workflow.${workflow.called}`, 'pass', `${workflow.path} 固定到完整 SHA ${callerPin.slice(0, 12)}…。`)
      : finding(`workflow.${workflow.called}`, 'fail', `${workflow.path} 未唯一固定到完整 40 位 Steward SHA。`,
        '将薄 workflow 固定到经过验证的 Steward called-workflow 提交。'));
  }
  if (governancePins.length > 1) {
    const uniquePins = new Set(governancePins);
    findings.push(uniquePins.size === 1
      ? finding('workflow.governance-pins', 'pass', 'Classification、Governance、Review Signal 与 Matrix caller 使用同一治理版本面。')
      : finding('workflow.governance-pins', 'fail', 'PR 治理 caller 固定到了不同 Steward SHA。',
        '将四条相互协作的 PR 治理 caller 一次性升级到同一已验证 SHA；Release 可独立版本化。'));
  }

  let appId = 0;
  if (String(repository.owner?.type ?? '').toLowerCase() === 'organization') {
    const installations = await optionalPagedRequest<{ installations?: InstallationPayload[] }, InstallationPayload>(
      transport,
      { path: `/orgs/${segment(String(repository.owner?.login ?? options.owner))}/installations` },
      (payload) => payload.installations ?? [],
    );
    const installation = installations?.find((candidate) => (
      String(candidate.client_id ?? '') === loaded.manifest.automation.githubApp.clientId
      && String(candidate.app_slug ?? '').toLowerCase() === loaded.manifest.automation.githubApp.slug
    ));
    if (!installations) {
      findings.push(finding('app.installation', 'warning', '当前 token 无法读取组织 GitHub App installations。',
        '使用具有 read:org 的组织管理员 token 重新运行。'));
    } else if (!installation || installation.suspended_at) {
      findings.push(finding('app.installation', 'fail', '组织中未找到 Manifest 指定的有效 GitHub App installation。',
        `安装或恢复 https://github.com/apps/${loaded.manifest.automation.githubApp.slug}/installations/new。`));
    } else {
      appId = Number(installation.app_id ?? 0);
      const missing = Object.entries(installationPermissions(loaded.manifest))
        .filter(([name, required]) => !permissionSatisfies(installation.permissions?.[name], required))
        .map(([name, required]) => `${name}:${required}`);
      if (!Number.isSafeInteger(appId) || appId < 1) missing.unshift('app_id');
      findings.push(missing.length
        ? finding('app.installation', 'fail', `GitHub App installation 缺少权限：${missing.join(', ')}。`, '在 App 设置中补齐权限并由组织接受变更。')
        : finding('app.installation', 'pass', `组织 installation ${installation.id} 存在且权限满足启用功能。`));
    }
  } else {
    findings.push(finding('app.installation', 'warning', '首版 doctor 无法用普通用户 token 直接列出个人账号 installation。',
      `核对 https://github.com/apps/${loaded.manifest.automation.githubApp.slug}/installations/new，并使用当前-head App Check 作为仓库范围证据。`));
  }

  const pulls = await optionalPagedRequest<PullPayload[], PullPayload>(transport, {
    path: `${path}/pulls`, query: { state: 'open', sort: 'updated', direction: 'desc' },
  }, (payload) => payload) ?? [];
  const pull = options.pullRequest
    ? pulls.find((candidate) => candidate.number === options.pullRequest)
    : pulls[0];
  if (options.pullRequest && !pull) {
    findings.push(finding('checks.current-head', 'fail', `未找到开放 PR #${options.pullRequest}。`, '传入开放 PR 编号，或省略 --pr 使用最近更新的开放 PR。'));
  } else if (!pull?.number || !pull.head?.sha || pull.base?.ref !== defaultBranch) {
    findings.push(finding('checks.current-head', 'warning', '没有可用于验证当前-head App Check 的开放默认分支 PR。', '创建或指定一个开放 PR 后重新运行 doctor。'));
  } else {
    const checks = await optionalPagedRequest<{ check_runs?: GitHubCheckRun[] }, GitHubCheckRun>(transport, {
      path: `${path}/commits/${segment(pull.head.sha)}/check-runs`,
    }, (payload) => payload.check_runs ?? []) ?? [];
    const namedGate = checks.find((check) => check.name === matrixGateName);
    const correctApp = String(namedGate?.app?.slug ?? '').toLowerCase() === loaded.manifest.automation.githubApp.slug;
    const checkAppId = Number(namedGate?.app?.id ?? 0);
    if (!appId && correctApp && Number.isSafeInteger(checkAppId) && checkAppId > 0) appId = checkAppId;
    const identity = parseStewardCheckExternalId(namedGate?.external_id);
    const trusted = Boolean(namedGate && correctApp && identity
      && identity.repositoryId === repositoryId
      && identity.prNumber === pull.number
      && identity.headSha === pull.head.sha.toLowerCase()
      && identity.checkId === 'validation-matrix'
      && identity.configDigest === loaded.configDigest);
    if (trusted) {
      findings.push(finding('checks.current-head', 'pass', `PR #${pull.number} 当前 head 的 Matrix Gate 来源、external_id 与 Manifest digest 均可信。`));
    } else if (!namedGate) {
      findings.push(finding('checks.current-head', 'fail', `PR #${pull.number} 当前 head 缺少 ${matrixGateName}。`,
        '先运行完整 Matrix 验证；不要用 GitHub Actions job 冒充 App Check。'));
    } else if (!correctApp) {
      findings.push(finding('checks.current-head', 'fail', `PR #${pull.number} 当前 head 的 Matrix Gate 不是由 Manifest 指定 App 创建。`,
        '重新运行 Steward Matrix，并确保 ruleset 绑定正确 App 来源。'));
    } else if (!identity) {
      findings.push(finding('checks.current-head', 'fail', `PR #${pull.number} 当前 head 的 Matrix Gate 缺少有效版本化 external_id。`,
        '使用当前 Steward Matrix 重新生成 App Check。'));
    } else if (identity.configDigest !== loaded.configDigest) {
      findings.push(finding('checks.current-head', 'fail', `PR #${pull.number} 当前 head 的 Matrix Gate 使用旧 Manifest digest ${identity.configDigest.slice(0, 12)}…。`,
        '在当前默认分支配置下重新运行完整 Matrix 验证。'));
    } else {
      findings.push(finding('checks.current-head', 'fail', `PR #${pull.number} 当前 head 的 Matrix Gate external_id 与 repository/PR/head/check 身份不一致。`,
        '拒绝该证据并重新运行完整 Matrix 验证。'));
    }
  }

  const rulesetList = await optionalPagedRequest<RulesetPayload[], RulesetPayload>(
    transport, { path: `${path}/rulesets` }, (payload) => payload,
  );
  if (!rulesetList) {
    findings.push(finding('ruleset.matrix', 'warning', '当前 token 无法读取 repository rulesets。', '使用具有仓库管理员权限的 token 重新运行。'));
  } else {
    const details = await Promise.all(rulesetList.map(async (item) => (
      item.id ? await transport.request<RulesetPayload>({ path: `${path}/rulesets/${segment(item.id)}` }) : item
    )));
    const required = details.flatMap((item) => (
      item.enforcement === 'active' && item.target === 'branch' && rulesetTargetsDefaultBranch(item, defaultBranch)
        ? (item.rules ?? []).filter((rule) => rule.type === 'required_status_checks')
          .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        : []
    )).filter((check) => check.context === matrixGateName);
    if (!appId) {
      findings.push(finding('ruleset.matrix', 'warning', `${matrixGateName} 的 required check 可读取，但没有可信 App ID 可验证 integration_id。`,
        '使用可读取组织 installation 的管理员 token，或指定带当前-head App Check 的开放 PR。'));
    } else {
      const trusted = required.some((check) => check.integration_id === appId);
      findings.push(trusted
        ? finding('ruleset.matrix', 'pass', `${matrixGateName} 在默认分支 active ruleset 中按 App 来源要求。`)
        : finding('ruleset.matrix', 'fail', `${matrixGateName} 未在默认分支 active ruleset 中绑定正确 App 来源。`,
          '使用 activate 合并 required check；保留所有非 Steward 规则。'));
    }
  }

  if (loaded.manifest.features.webhookRelay) {
    const runs = await optionalRequest<{ workflow_runs?: GitHubWorkflowRun[] }>(transport, {
      path: `${path}/actions/runs`, query: { event: 'repository_dispatch', per_page: 100 },
    });
    const latest = runs?.workflow_runs?.[0];
    findings.push(!runs
      ? finding('relay.dispatch', 'warning', '当前 token 无法读取最近的 repository_dispatch runs。',
        '使用具有 Actions read 权限的 token 重新运行。')
      : latest
      ? finding('relay.dispatch', latest.status === 'completed' && latest.conclusion === 'success' ? 'pass' : 'warning',
        `最近可识别 repository_dispatch run ${latest.id}：${latest.status ?? 'unknown'}/${latest.conclusion ?? 'unknown'}。`,
        latest.conclusion === 'success' ? undefined : '检查 Relay delivery 与对应 Matrix/Governance run。')
      : finding('relay.dispatch', 'warning', '最近 100 条中没有可识别的 repository_dispatch run。', '产生受控 review/resolve 事件并核对 Relay delivery。'));
  }

  if (loaded.manifest.features.release && loaded.manifest.release) {
    const candidate = loaded.manifest.release.adapterCommand.find((argument) => /[\\/]/.test(argument));
    if (!candidate) {
      findings.push(finding('release.adapter', 'warning', 'Release adapter argv 未包含可远程核对的仓库相对路径。', '在目标 runner 上执行 contract 验证。'));
    } else {
      const repositoryAdapterPath = candidate.replaceAll('\\', '/');
      const adapter = await optionalRequest<{ type?: string }>(transport, {
        path: `${path}/contents/${repositoryAdapterPath.split('/').map(segment).join('/')}`, query: { ref: defaultBranch },
      });
      findings.push(adapter?.type === 'file'
        ? finding('release.adapter', 'pass', `Release adapter ${candidate} 存在；执行 contract 由 Release workflow 在可信 runner 上验证。`)
        : finding('release.adapter', 'fail', `Release adapter ${candidate} 不存在或不是普通文件。`, '修复 Manifest adapterCommand 或提交 adapter 文件。'));
    }
  }

  return report(fullName, findings);
}
