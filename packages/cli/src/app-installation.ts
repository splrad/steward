import { GitHubApiError, type GitHubRequest, type GitHubTransport } from '../../github/src/index.js';
import type { StewardManifest } from '../../manifest/src/index.js';

export type AppInstallationStatus = 'installed' | 'action-required' | 'unknown';
export type AppInstallationReason = 'installed' | 'account-installation-missing' | 'installation-suspended'
  | 'permissions-missing' | 'repository-not-selected' | 'verification-unavailable';

export interface AppInstallationReport {
  repository: string;
  appSlug: string;
  status: AppInstallationStatus;
  reason: AppInstallationReason;
  summary: string;
  installationId?: number;
  appId?: number;
  missingPermissions?: string[];
  actionUrl?: string;
}

interface RepositoryPayload {
  id?: number;
  full_name?: string;
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
  html_url?: string;
  account?: { login?: string; type?: string } | null;
}

interface InstallationRepositoryPayload {
  id?: number;
  full_name?: string;
}

export interface AppInstallationOptions {
  owner: string;
  repository: string;
  repositoryId: number;
  ownerLogin: string;
  ownerType: string;
  manifest: StewardManifest;
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

function installationUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

function configurationUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password
      ? url.href
      : fallback;
  } catch {
    return fallback;
  }
}

function accessUnavailable(error: unknown): boolean {
  return error instanceof GitHubApiError && [401, 403, 404].includes(error.status);
}

async function pagedRequest<TPayload, TItem>(
  transport: GitHubTransport,
  request: GitHubRequest,
  items: (payload: TPayload) => readonly TItem[],
): Promise<TItem[] | null> {
  const collected: TItem[] = [];
  for (let page = 1; page <= 20; page += 1) {
    let payload: TPayload;
    try {
      payload = await transport.request<TPayload>({
        ...request,
        query: { ...request.query, page, per_page: 100 },
      });
    } catch (error) {
      if (accessUnavailable(error)) return null;
      throw error;
    }
    const batch = [...items(payload)];
    collected.push(...batch);
    if (batch.length < 100) return collected;
  }
  throw new Error('GitHub installation read exceeded the 20-page safety limit');
}

function requiredPermissions(manifest: StewardManifest): Record<string, 'read' | 'write'> {
  const required: Record<string, 'read' | 'write'> = {
    checks: 'write',
    contents: manifest.features.release || manifest.features.webhookRelay ? 'write' : 'read',
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

function unknown(options: AppInstallationOptions, summary: string): AppInstallationReport {
  return {
    repository: `${options.owner}/${options.repository}`,
    appSlug: options.manifest.automation.githubApp.slug,
    status: 'unknown',
    reason: 'verification-unavailable',
    summary,
  };
}

export async function inspectAppInstallation(
  transport: GitHubTransport,
  options: AppInstallationOptions,
): Promise<AppInstallationReport> {
  const fullName = `${options.owner}/${options.repository}`;
  const slug = options.manifest.automation.githubApp.slug;
  const newInstallationUrl = installationUrl(slug);
  const organization = options.ownerType.toLowerCase() === 'organization';
  const installations = organization
    ? await pagedRequest<{ installations?: InstallationPayload[] }, InstallationPayload>(
      transport,
      { path: `/orgs/${segment(options.ownerLogin)}/installations` },
      (payload) => payload.installations ?? [],
    )
    : await pagedRequest<{ installations?: InstallationPayload[] }, InstallationPayload>(
      transport,
      { path: '/user/installations' },
      (payload) => payload.installations ?? [],
    );
  if (!installations) {
    return unknown(options, organization
      ? '当前 token 无法读取组织 GitHub App installations；需要组织管理员权限和 read:org。'
      : '当前 token 无法读取用户 GitHub App installations；需要兼容该端点的 GitHub App user token 或 personal access token。');
  }

  const installation = installations.find((candidate) => (
    String(candidate.client_id ?? '') === options.manifest.automation.githubApp.clientId
    && String(candidate.app_slug ?? '').toLowerCase() === slug.toLowerCase()
    && (organization || String(candidate.account?.login ?? '').toLowerCase() === options.ownerLogin.toLowerCase())
  ));
  if (!installation) {
    return {
      repository: fullName,
      appSlug: slug,
      status: 'action-required',
      reason: 'account-installation-missing',
      summary: `账号 ${options.ownerLogin} 尚未安装 Manifest 指定的 GitHub App。`,
      actionUrl: newInstallationUrl,
    };
  }

  const installationId = Number(installation.id ?? 0);
  const appId = Number(installation.app_id ?? 0);
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    return unknown(options, 'GitHub 返回的 App installation 缺少可信 installation_id。');
  }
  const actionUrl = configurationUrl(installation.html_url, newInstallationUrl);
  if (!Number.isSafeInteger(appId) || appId < 1) {
    return {
      repository: fullName, appSlug: slug, status: 'action-required', reason: 'permissions-missing',
      summary: `GitHub App installation ${installationId} 缺少可信 app_id。`,
      installationId, missingPermissions: ['app_id'], actionUrl,
    };
  }
  if (installation.suspended_at) {
    return {
      repository: fullName, appSlug: slug, status: 'action-required', reason: 'installation-suspended',
      summary: `GitHub App installation ${installationId} 已暂停。`, installationId, appId, actionUrl,
    };
  }

  const missingPermissions = Object.entries(requiredPermissions(options.manifest))
    .filter(([name, required]) => !permissionSatisfies(installation.permissions?.[name], required))
    .map(([name, required]) => `${name}:${required}`);
  if (missingPermissions.length) {
    return {
      repository: fullName, appSlug: slug, status: 'action-required', reason: 'permissions-missing',
      summary: `GitHub App installation ${installationId} 缺少所需权限：${missingPermissions.join(', ')}。`,
      installationId, appId, missingPermissions, actionUrl,
    };
  }

  if (installation.repository_selection === 'all') {
    return {
      repository: fullName, appSlug: slug, status: 'installed', reason: 'installed',
      summary: `GitHub App installation ${installationId} 已授权全部账号仓库。`, installationId, appId,
    };
  }
  if (installation.repository_selection !== 'selected') {
    return unknown(options, `GitHub 返回未知 repository_selection：${String(installation.repository_selection ?? '')}。`);
  }

  const repositories = await pagedRequest<
    { repositories?: InstallationRepositoryPayload[] }, InstallationRepositoryPayload
  >(
    transport,
    { path: `/user/installations/${segment(installationId)}/repositories` },
    (payload) => payload.repositories ?? [],
  );
  if (!repositories) {
    return unknown(options, '当前 token 无法验证 selected installation 的仓库范围；普通 GitHub CLI OAuth token 不适用，需改用兼容的 GitHub App user token 或 personal access token。');
  }
  const selected = repositories.some((candidate) => (
    Number(candidate.id ?? 0) === options.repositoryId
    || String(candidate.full_name ?? '').toLowerCase() === fullName.toLowerCase()
  ));
  return selected
    ? {
      repository: fullName, appSlug: slug, status: 'installed', reason: 'installed',
      summary: `GitHub App installation ${installationId} 已包含目标仓库。`, installationId, appId,
    }
    : {
      repository: fullName, appSlug: slug, status: 'action-required', reason: 'repository-not-selected',
      summary: `GitHub App installation ${installationId} 尚未选择目标仓库。`, installationId, appId, actionUrl,
    };
}

export async function runAppInstallationPreflight(
  transport: GitHubTransport,
  options: { owner: string; repository: string; manifest: StewardManifest },
): Promise<AppInstallationReport> {
  const repository = await transport.request<RepositoryPayload>({
    path: `/repos/${segment(options.owner)}/${segment(options.repository)}`,
  });
  const repositoryId = Number(repository.id ?? 0);
  const fullName = String(repository.full_name ?? '');
  const ownerLogin = String(repository.owner?.login ?? '');
  const ownerType = String(repository.owner?.type ?? '');
  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 || !fullName || !ownerLogin || !ownerType
    || fullName.toLowerCase() !== `${options.owner}/${options.repository}`.toLowerCase()) {
    throw new Error('GitHub returned invalid repository metadata');
  }
  return inspectAppInstallation(transport, {
    ...options, repositoryId, ownerLogin, ownerType,
  });
}
