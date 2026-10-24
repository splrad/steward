import { parseRepositoryCatalog, type RepositoryPolicy } from '../../core/src/repository-policy.js';
import { nativeGhCommand, type GhCommand } from './gh-release.js';

function fail(reason: string): never { throw new Error(`CONTROL_PLANE: ${reason}`); }
export type Capability = 'managedSync' | 'dependencyUpdates' | 'release';
export class NativeControlPlane {
  constructor(private readonly gh: GhCommand = nativeGhCommand) {}
  private async json(path: string) { return JSON.parse(await this.gh(['api', path])); }
  async catalog() {
    const repository = await this.json('repos/splrad/steward');
    if (repository.id !== 1296724484 || repository.full_name !== 'splrad/steward' || repository.default_branch !== 'main') fail('policy repository identity');
    const commit = await this.json('repos/splrad/steward/commits/main');
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) fail('observation commit');
    const file = await this.json(`repos/splrad/steward/contents/config/repositories.json?ref=${commit.sha}`);
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') fail('catalog blob');
    return { observationSha: commit.sha as string, catalog: parseRepositoryCatalog(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))) };
  }
  async targets(capability: Capability, repository?: string) {
    const current = await this.catalog();
    const repositories = Object.values(current.catalog.repositories);
    if (repository && !repositories.some(item => item.fullName === repository)) fail('unregistered target');
    const enabled = repositories.filter(item => (!repository || item.fullName === repository) && item.managed
      && (capability === 'release' ? item.release.enabled : item.automation[capability].enabled));
    return { observationSha: current.observationSha, include: enabled.sort((a, b) => a.repositoryId - b.repositoryId).map(item => ({
      repositoryId: item.repositoryId, fullName: item.fullName, repository: item.fullName.split('/')[1]!, defaultBranch: item.defaultBranch,
      policySha: item.automation.managedSync.policySha,
    })) };
  }
  async syncPreflight(repositoryId: number, policySha: string, expectedBaseSha?: string) {
    const current = await this.catalog(), repository = current.catalog.repositories[String(repositoryId)];
    if (!repository) fail('unregistered target');
    if (!repository.managed || !repository.automation.managedSync.enabled) return { mode: 'not-enabled' as const, observationSha: current.observationSha };
    if (!/^[a-f0-9]{40}$/.test(policySha) || repository.automation.managedSync.policySha !== policySha || repository.revokedPolicyShas.includes(policySha)) fail('policy changed or revoked');
    const history = await this.json(`repos/splrad/steward/compare/${policySha}...${current.observationSha}`);
    if (!['ahead', 'identical'].includes(history.status) || history.merge_base_commit?.sha !== policySha) fail('policy outside protected main history');
    const actual = await this.json(`repos/${repository.fullName}`);
    if (actual.id !== repositoryId || actual.full_name !== repository.fullName || actual.default_branch !== repository.defaultBranch || actual.archived || actual.disabled) fail('target identity');
    const main = await this.json(`repos/${repository.fullName}/commits/${encodeURIComponent(repository.defaultBranch)}`);
    if (!/^[a-f0-9]{40}$/.test(main.sha) || expectedBaseSha && main.sha !== expectedBaseSha) fail('target main changed');
    const rulesets = JSON.parse(await this.gh(['api', '--paginate', '--slurp', `repos/${repository.fullName}/rulesets?includes_parents=true&per_page=100`]));
    if (!Array.isArray(rulesets) || !rulesets.length || rulesets.some(page => !Array.isArray(page))) fail('ruleset inventory');
    const candidates = rulesets.flat().filter(item => item.name === 'SPLRAD Managed Branch' && item.enforcement === 'active');
    if (candidates.length !== 1 || !Number.isSafeInteger(candidates[0].id)) fail('managed branch ruleset missing or ambiguous');
    const rule = await this.json(`repos/${repository.fullName}/rulesets/${candidates[0].id}`);
    assertManagedBranchRule(rule);
    // List refs rather than treating an arbitrary HTTP failure as an absent branch.
    const refs = await this.json(`repos/${repository.fullName}/git/matching-refs/heads/steward/managed-sync`);
    if (!Array.isArray(refs)) fail('branch inventory');
    const branch = refs.filter(ref => ref.ref === 'refs/heads/steward/managed-sync');
    if (branch.length > 1) fail('ambiguous managed branch');
    if (branch.length) {
      const branchSha = branch[0].object?.sha;
      if (!/^[a-f0-9]{40}$/.test(branchSha)) fail('managed branch identity');
      const compare = await this.json(`repos/${repository.fullName}/compare/${main.sha}...${branchSha}`);
      if (!Array.isArray(compare.commits) || compare.commits.length !== compare.ahead_by || compare.total_commits !== compare.commits.length
        || !['ahead', 'identical', 'diverged'].includes(compare.status)) fail('incomplete managed branch history');
      if (compare.commits.some((commit: any) => commit.committer?.id !== 301115370 || commit.author?.id !== 301115370
        || commit.commit?.verification?.verified !== true)) fail('human or unproven managed branch commit');
    }
    return { mode: 'enabled' as const, observationSha: current.observationSha, policySha, expectedBaseSha: main.sha as string, repository };
  }
  async dependencyPreflight(repositoryId: number, policySha: string) {
    const current = await this.catalog(), repository = current.catalog.repositories[String(repositoryId)];
    if (!repository) fail('unregistered target');
    if (!repository.managed || !repository.automation.dependencyUpdates.enabled) return { mode: 'not-enabled' as const, observationSha: current.observationSha };
    if (!/^[a-f0-9]{40}$/.test(policySha) || repository.revokedPolicyShas.includes(policySha)) fail('revoked update policy');
    const history = await this.json(`repos/splrad/steward/compare/${policySha}...${current.observationSha}`);
    if (!['ahead', 'identical'].includes(history.status) || history.merge_base_commit?.sha !== policySha) fail('update policy outside main history');
    const actual = await this.json(`repos/${repository.fullName}`);
    if (actual.id !== repositoryId || actual.full_name !== repository.fullName || actual.default_branch !== repository.defaultBranch || actual.archived || actual.disabled) fail('target identity');
    return { mode: 'enabled' as const, observationSha: current.observationSha, repository };
  }
}
export function assertManagedBranchRule(rule: any) {
  if (rule.name !== 'SPLRAD Managed Branch' || rule.enforcement !== 'active' || rule.target !== 'branch'
    || JSON.stringify(rule.conditions?.ref_name?.include) !== '["refs/heads/steward/managed-sync"]'
    || JSON.stringify(rule.conditions?.ref_name?.exclude) !== '[]'
    || !Array.isArray(rule.rules) || ['creation', 'update', 'deletion'].some(type => !rule.rules.some((item: any) => item.type === type))
    || !Array.isArray(rule.bypass_actors) || rule.bypass_actors.length !== 1 || rule.bypass_actors[0].actor_type !== 'Integration'
    || rule.bypass_actors[0].actor_id !== 4243096 || rule.bypass_actors[0].bypass_mode !== 'always') fail('managed branch single writer protection');
}
