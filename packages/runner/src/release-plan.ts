import { isDeepStrictEqual } from 'node:util';
import { PullRequestBody } from 'release-please/build/src/util/pull-request-body.js';
import { TagName } from 'release-please/build/src/util/tag-name.js';
import { Version } from 'release-please/build/src/version.js';
import { parseReleaseDescriptor } from '../../core/src/release-descriptor.js';
import { planNativeRelease, type NativeCandidateState, type NativeReleaseState } from '../../core/src/release-plan.js';
import { parseRepositoryCatalog, releaseWriteAuthority } from '../../core/src/repository-policy.js';
import { NativeControlPlane } from './native-control-plane.js';
import { nativeGhCommand, type GhCommand } from './gh-release.js';

function fail(reason: string): never { throw new Error(`RELEASE_PLAN: ${reason}`); }
interface PlannedReleaseUnit {
  unitId: string; path: string; version: string; tag: string; releasePr: number; releaseId: number | null; S: string;
  publishRunId: number | null; attempt: number | null; mode: string; reason: string;
}
export class NativeReleasePlanner {
  constructor(private readonly gh: GhCommand = nativeGhCommand) {}
  private async get(path: string) { return JSON.parse(await this.gh(['api', path])); }
  private async pages(path: string, collection?: string): Promise<any[]> {
    const pages = JSON.parse(await this.gh(['api', '--paginate', '--slurp', path]));
    if (!Array.isArray(pages) || !pages.length) fail('incomplete pagination');
    if (!collection) { if (pages.some(page => !Array.isArray(page))) fail('invalid pagination'); return pages.flat(); }
    if (pages.some(page => !Array.isArray(page[collection]) || page.total_count !== pages[0].total_count)) fail('pagination drift');
    const all = pages.flatMap(page => page[collection]);
    if (all.length !== pages[0].total_count || new Set(all.map(item => item.id)).size !== all.length) fail('incomplete collection');
    return all;
  }
  private async file(repository: string, sha: string, path: string) {
    const file = await this.get(`repos/${repository}/contents/${path}?ref=${sha}`);
    if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') fail('source blob');
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  }
  async inspect(repositoryId: number, policySha: string, phase: 'before' | 'after') {
    if (!['before', 'after'].includes(phase) || !/^[a-f0-9]{40}$/.test(policySha)) fail('inspection input');
    const current = await new NativeControlPlane(this.gh).catalog(), policy = current.catalog.repositories[String(repositoryId)];
    if (!policy) fail('unregistered repository');
    const base = { repositoryId, observationSha: current.observationSha, candidateHead: null as string | null, should_run_release: false, should_run_pr: false, units: [] as PlannedReleaseUnit[] };
    if (!policy.managed || !policy.release.enabled) return { ...base, mode: 'not-enabled' };
    if (policy.revokedPolicyShas.includes(policySha)) fail('revoked policy');
    const history = await this.get(`repos/splrad/steward/compare/${policySha}...${current.observationSha}`);
    if (!['ahead', 'identical'].includes(history.status) || history.merge_base_commit?.sha !== policySha) fail('untrusted policy history');
    const pinned = parseRepositoryCatalog(await this.file('splrad/steward', policySha, 'config/repositories.json')).repositories[String(repositoryId)];
    // Live switches authorize writes; release semantics must still match the
    // selected policy. Never combine old defaults with newer units/boundaries.
    const contract = (value: typeof policy) => ({ fullName: value.fullName, defaultBranch: value.defaultBranch,
      units: Object.fromEntries(Object.entries(value.release.units).map(([id, unit]) => [id, { ...unit, enabled: false }])) });
    if (!pinned || !isDeepStrictEqual(contract(pinned), contract(policy))) fail('release policy drift');
    const actual = await this.get(`repos/${policy.fullName}`);
    if (actual.id !== repositoryId || actual.full_name !== policy.fullName || actual.default_branch !== policy.defaultBranch) fail('repository identity');
    // Release Please consumes this branch's config with a write token. Validate it
    // before permitting either native writer, not only in the later product job.
    const tip = await this.get(`repos/${policy.fullName}/commits/${encodeURIComponent(policy.defaultBranch)}`);
    if (!/^[a-f0-9]{40}$/.test(tip.sha)) fail('release configuration source');
    const [liveConfig, rawUnits, defaults, boundaries] = await Promise.all([
      this.file(policy.fullName, tip.sha, 'release-please-config.json'),
      this.file(policy.fullName, tip.sha, '.github/steward-release.json'),
      this.file('splrad/steward', policySha, 'config/release/defaults.json'),
      this.file('splrad/steward', policySha, 'config/release/bootstrap.json'),
    ]);
    const { units } = parseReleaseDescriptor(rawUnits), boundary = boundaries[String(repositoryId)];
    if (!/^[a-f0-9]{40}$/.test(boundary) || defaults.draft !== true || defaults['force-tag-creation'] !== true
      || units.some(unit => unit.ecosystem !== 'native')
      || !isDeepStrictEqual(units.map(unit => unit.id).sort(), Object.keys(policy.release.units).sort())) fail('release configuration policy');
    const expectedConfig = { ...defaults, 'bootstrap-sha': boundary, packages: Object.fromEntries(units.map(unit => [unit.releasePleasePath,
      { 'release-type': 'simple', 'version-file': unit.versionFile, 'changelog-path': unit.changelogPath }])) };
    if (!isDeepStrictEqual(liveConfig, expectedConfig)) fail('untrusted Release Please configuration');
    const [pulls, releases] = await Promise.all([
      this.pages(`repos/${policy.fullName}/pulls?state=all&base=${encodeURIComponent(policy.defaultBranch)}&per_page=100`),
      this.pages(`repos/${policy.fullName}/releases?per_page=100`),
    ]);
    const candidates: NativeCandidateState[] = [], expected: PlannedReleaseUnit[] = [];
    const pendingCandidates = new Set<number>();
    for (const pull of pulls) {
      if (!String(pull.head?.ref).startsWith('release-please--branches--')) continue;
      if (pull.user?.id !== 301115370 || pull.base?.repo?.id !== repositoryId || pull.head?.repo?.id !== repositoryId || pull.base.ref !== policy.defaultBranch) fail('untrusted Release Please candidate');
      const labels = (pull.labels ?? []).map((label: any) => label.name);
      const merged = Boolean(pull.merged_at);
      if (!merged) {
        candidates.push({ number: pull.number, merged: false, closed: pull.state === 'closed', editing: labels.includes('release:editing'), mergeSha: null, expectedUnits: [] });
        if (pull.state === 'open') {
          if (base.candidateHead && base.candidateHead !== pull.head.sha) fail('multiple open candidates');
          base.candidateHead = pull.head.sha;
        }
        continue;
      }
      const S = pull.merge_commit_sha;
      if (!/^[a-f0-9]{40}$/.test(S)) fail('merged source');
      let afterAdoption = false;
      for (const unitPolicy of Object.values(policy.release.units).filter(unit => unit.enabled)) {
        const boundary = unitPolicy.adoptedAfterTag ? (await this.get(`repos/${policy.fullName}/commits/${encodeURIComponent(unitPolicy.adoptedAfterTag)}`)).sha : unitPolicy.adoptedFromSha;
        if (!boundary || !/^[a-f0-9]{40}$/.test(boundary)) fail('unresolved adoption boundary');
        const ancestry = await this.get(`repos/${policy.fullName}/compare/${boundary}...${S}`);
        if (ancestry.status === 'ahead' && ancestry.merge_base_commit?.sha === boundary) afterAdoption = true;
      }
      if (!afterAdoption) continue;
      const commit = await this.get(`repos/${policy.fullName}/commits/${S}`);
      if (commit.sha !== S || commit.parents?.length !== 1) fail('release PR must be a squash source');
      const [manifest, previous, config, rawDescriptor] = await Promise.all([
        this.file(policy.fullName, S, '.release-please-manifest.json'), this.file(policy.fullName, commit.parents[0].sha, '.release-please-manifest.json'),
        this.file(policy.fullName, S, 'release-please-config.json'), this.file(policy.fullName, S, '.github/steward-release.json'),
      ]);
      const descriptor = parseReleaseDescriptor(rawDescriptor), body = PullRequestBody.parse(pull.body ?? '');
      if (!body) fail('native Release Please body');
      const changed = descriptor.units.filter(unit => manifest[unit.releasePleasePath] !== previous[unit.releasePleasePath]);
      const admitted: string[] = [];
      for (const unit of changed) {
        const unitPolicy = policy.release.units[unit.id]; if (!unitPolicy?.enabled) continue;
        const boundary = unitPolicy.adoptedAfterTag
          ? (await this.get(`repos/${policy.fullName}/commits/${encodeURIComponent(unitPolicy.adoptedAfterTag)}`)).sha : unitPolicy.adoptedFromSha;
        if (!boundary || !/^[a-f0-9]{40}$/.test(boundary)) fail('unresolved adoption boundary');
        const compare = await this.get(`repos/${policy.fullName}/compare/${boundary}...${S}`);
        if (compare.status !== 'ahead' || compare.merge_base_commit?.sha !== boundary) continue;
        const packageConfig = config.packages?.[unit.releasePleasePath]; if (!packageConfig) fail('native package configuration');
        const version = Version.parse(manifest[unit.releasePleasePath]).toString();
        const component = (packageConfig['include-component-in-tag'] ?? config['include-component-in-tag'] ?? true) ? packageConfig.component : undefined;
        if (component !== undefined && component !== unit.id) fail('tag component');
        if (!body.releaseData.some(data => data.version?.toString() === version && (descriptor.units.length === 1 || data.component === component))) fail('PR/native manifest mismatch');
        const tag = new TagName(Version.parse(version), component, packageConfig['tag-separator'] ?? config['tag-separator'] ?? '-', packageConfig['include-v-in-tag'] ?? config['include-v-in-tag'] ?? true).toString();
        expected.push({ unitId: unit.id, path: unit.path, version, tag, releasePr: pull.number, releaseId: null, S, publishRunId: null, attempt: null, mode: 'missing', reason: 'merged-native-candidate' });
        admitted.push(unit.id);
      }
      if (admitted.length) {
        candidates.push({ number: pull.number, merged: true, closed: true, editing: false, mergeSha: S, expectedUnits: admitted });
        if (labels.includes('autorelease: pending')) pendingCandidates.add(pull.number);
      }
    }
    const states: NativeReleaseState[] = [];
    for (const release of releases) {
      const matches = expected.filter(unit => unit.tag === release.tag_name);
      if (!matches.length) { if (release.draft) fail('unknown-origin draft'); continue; }
      if (matches.length !== 1 || !Number.isSafeInteger(release.id) || release.id < 1) fail('ambiguous release identity');
      const unit = matches[0]!;
      if (unit.releaseId) fail('duplicate tag release');
      if (release.author?.id !== 301115370) fail('untrusted release creator');
      const commit = await this.get(`repos/${policy.fullName}/commits/${encodeURIComponent(unit.tag)}`);
      if (commit.sha !== unit.S) fail('tag/merged PR mismatch');
      unit.releaseId = release.id;
      const runs = await this.publishRuns(policy.fullName, repositoryId, unit);
      const run = runs[0]; let verified = false;
      if (run) {
        unit.publishRunId = run.id; unit.attempt = run.run_attempt;
        if (run.status === 'completed' && run.conclusion === 'success' && !release.draft && release.immutable === true) {
          const jobs = await this.pages(`repos/${policy.fullName}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, 'jobs');
          verified = jobs.some(job => job.name === 'publish / verify' && job.status === 'completed' && job.conclusion === 'success' && job.head_sha === unit.S);
        }
      }
      unit.mode = verified ? 'satisfied' : release.draft ? 'recover' : 'verify';
      states.push({ id: release.id, unitId: unit.unitId, tag: unit.tag, sourceSha: unit.S, draft: release.draft, owned: true, verified, abandoned: false });
    }
    const missing = expected.filter(unit => unit.releaseId === null);
    if (missing.some(unit => !pendingCandidates.has(unit.releasePr))) fail('partial release requires explicit native-object recovery');
    const plan = planNativeRelease({ enabled: true, units: Object.entries(policy.release.units).map(([id, unit]) => ({ id, ...unit })), releases: states, candidates, complete: true });
    const obligations = expected.filter(unit => unit.mode !== 'satisfied');
    return { ...base, mode: plan.mode, units: obligations, should_run_release: phase === 'before' && plan.mode === 'release-only',
      should_run_pr: phase === 'after' && plan.mode === 'release-only' && obligations.length === 0 };
  }
  private async publishRuns(repository: string, repositoryId: number, unit: PlannedReleaseUnit) {
    const workflow = await this.get(`repos/${repository}/actions/workflows/steward-release-publish.yml`);
    if (workflow.path !== '.github/workflows/steward-release-publish.yml' || !Number.isSafeInteger(workflow.id)) fail('publish workflow identity');
    const runs = await this.pages(`repos/${repository}/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&head_sha=${unit.S}&per_page=100`, 'workflow_runs');
    return runs.filter(run => run.workflow_id === workflow.id && run.event === 'workflow_dispatch' && run.head_sha === unit.S
      && run.repository?.id === repositoryId && run.head_repository?.id === repositoryId
      && run.display_title === `Publish ${unit.unitId} / ${unit.tag} / ${unit.releaseId}`).sort((a, b) => b.id - a.id);
  }
  async dispatch(repositoryId: number, unitId: string, releaseId: number, releasePr: number, policySha: string) {
    const plan = await this.inspect(repositoryId, policySha, 'after');
    const unit = plan.units.find(unit => unit.unitId === unitId && unit.releaseId === releaseId && unit.releasePr === releasePr);
    if (!unit) fail('no exact pending release');
    const current = await new NativeControlPlane(this.gh).catalog();
    const { repository } = releaseWriteAuthority(current.catalog, repositoryId, current.catalog.repositories[String(repositoryId)]!.fullName, unitId, policySha);
    const runs = await this.publishRuns(repository.fullName, repositoryId, unit);
    if (runs.some(run => run.status !== 'completed')) return { status: 'waiting', runId: runs.find(run => run.status !== 'completed')!.id };
    const latest = runs[0];
    if (latest && unit.mode === 'recover') {
      if (latest.conclusion === 'success') fail('successful run left an unpublished draft');
      await this.gh(['run', 'rerun', String(latest.id), '--failed', '--repo', repository.fullName]);
      return { status: 'rerun-requested', runId: latest.id };
    }
    let error: unknown;
    try { await this.gh(['workflow', 'run', 'steward-release-publish.yml', '--repo', repository.fullName, '--ref', unit.tag,
      '-f', `unit=${unitId}`, '-f', `tag=${unit.tag}`, '-f', `release_id=${releaseId}`, '-f', `release_pr=${releasePr}`]); }
    catch (value) { error = value; }
    const observed = await this.publishRuns(repository.fullName, repositoryId, unit);
    const started = observed.find(run => !runs.some(prior => prior.id === run.id));
    if (!started) { if (error) throw error; fail('dispatch result not yet observed; inspect before retry'); }
    return { status: 'dispatched', runId: started.id };
  }
}
