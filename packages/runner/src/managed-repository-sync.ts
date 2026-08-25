import { isIssueCapableRepository } from "../../core/src/issues.js";

export interface ManagedCatalog {
  organization: { id: number; login: string };
  defaults: { public: Record<string, unknown>; private: Record<string, unknown> };
  repositories: Record<string, Record<string, unknown>>;
}
export interface ManagedTarget {
  repository: any;
  configuration: any;
  registration: "explicit" | "default-public" | "default-private";
  managed: boolean;
  issueCapable: boolean;
}

export function managedRepositoryTargets(catalog: ManagedCatalog, repositories: readonly any[], repositoryId?: number): ManagedTarget[] {
  const seen = new Set<number>();
  const targets: ManagedTarget[] = [];
  for (const repository of repositories) {
    const id = Number(repository?.id);
    if (!Number.isSafeInteger(id) || seen.has(id)) throw new Error("安装仓库清单包含无效或重复编号");
    seen.add(id);
    if (repositoryId && id !== repositoryId) continue;
    if (Number(repository.owner?.id) !== catalog.organization.id || String(repository.owner?.login).toLowerCase() !== catalog.organization.login.toLowerCase()) throw new Error(`安装仓库不属于目标组织: ${id}`);
    const override = catalog.repositories[String(id)];
    if (override?.fullName && override.fullName !== repository.full_name) throw new Error("仓库编号与中央目录名称不一致");
    const registration = override ? "explicit" : repository.private ? "default-private" : "default-public";
    const configuration = Object.freeze({ ...(repository.private ? catalog.defaults.private : catalog.defaults.public), ...(override ?? {}) });
    const managed = configuration.managed === true;
    targets.push({ repository, configuration, registration, managed, issueCapable: isIssueCapableRepository(repository, managed) });
  }
  if (repositoryId && !seen.has(repositoryId)) throw new Error("目标仓库不属于当前安装");
  return targets.sort((left, right) => Number(left.repository.id) - Number(right.repository.id));
}

export function managedRepositoryIds(targets: readonly ManagedTarget[]): number[] {
  const ids = targets.filter(target => target.managed).map(target => Number(target.repository?.id));
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) throw new Error("当前安装没有唯一的已纳管仓库编号");
  return ids.sort((left, right) => left - right);
}

export async function runManagedRepositorySync<T>(
  targets: readonly ManagedTarget[],
  adapter: (target: ManagedTarget) => Promise<T>,
): Promise<Array<{ target: ManagedTarget; status: "ok" | "ignored" | "failed"; result?: T; error?: string }>> {
  const results: Array<{ target: ManagedTarget; status: "ok" | "ignored" | "failed"; result?: T; error?: string }> = [];
  for (const target of targets) {
    if (!target.managed) { results.push({ target, status: "ignored" }); continue; }
    try { results.push({ target, status: "ok", result: await adapter(target) }); }
    catch (error) { results.push({ target, status: "failed", error: error instanceof Error ? error.message : "internal-error" }); }
  }
  return results;
}
