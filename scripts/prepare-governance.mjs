import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = code => { throw Error(`GOVERNANCE_DRAFT_${code}`); };
const id = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const allRepositories = { include: ['~ALL'], exclude: [], protected: false };
const actor = actorId => ({ actor_id: actorId, actor_type: 'Integration', bypass_mode: 'always' });
const rule = type => type === 'update' ? { type, parameters: { update_allows_fetch_and_merge: false } } : { type };
const approval = (count, threads) => ({ type: 'pull_request', parameters: {
  required_reviewers: [], required_approving_review_count: count, require_code_owner_review: false,
  dismiss_stale_reviews_on_push: true, require_last_push_approval: false,
  require_extra_approval_for_unattributed_changes: false, required_review_thread_resolution: threads,
  allowed_merge_methods: ['squash'],
} });
function nativeRule(name, refs, types, bypass) {
  return { name, target: 'branch', enforcement: 'active', conditions: {
    repository_name: structuredClone(allRepositories), ref_name: { include: refs, exclude: [] },
  }, rules: types.map(rule), bypass_actors: bypass };
}

/** Prepare native request bodies only. This developer/deployment helper has no API write operation. */
export function prepareGovernance(snapshot) {
  const { base, team, members, governanceApp, installation, validationCheck, policySha, legacyCandidates = [] } = snapshot;
  if (!digest(policySha) || base?.id !== 18883080 || base.source_type !== 'Organization' || base.source !== 'splrad'
    || base.target !== 'branch' || !Array.isArray(base.rules) || !Array.isArray(base.bypass_actors)) fail('BASE');
  if (!id(team?.id) || team.slug !== 'primary-account-approval-exception' || team.organization?.id !== 302208797
    || !Array.isArray(members) || members.length !== 1 || members[0]?.id !== 44151430
    || members[0]?.login !== 'axiomoth' || members[0]?.type !== 'User') fail('TEAM');
  if (!id(governanceApp?.id) || governanceApp.id === 4243096 || governanceApp.slug !== 'splrad-governance'
    || installation?.app_id !== governanceApp.id || !id(installation.id) || installation.account?.id !== 302208797
    || installation.repository_selection !== 'all' || installation.suspended_at) fail('APP');
  if (!id(validationCheck?.app?.id) || validationCheck.app.slug !== 'github-actions'
    || validationCheck.name !== 'SPLRAD Validation' || validationCheck.head_sha !== policySha
    || validationCheck.status !== 'completed' || validationCheck.conclusion !== 'success') fail('CHECK_SOURCE');
  const integration = validationCheck.app.id;
  const controlled = ['pull_request', 'required_status_checks', 'workflows'];
  if (controlled.some(type => base.rules.filter(item => item.type === type).length > 1)) fail('AMBIGUOUS_BASE');
  const status = base.rules.find(item => item.type === 'required_status_checks');
  const workflows = base.rules.find(item => item.type === 'workflows');
  if (status && !Array.isArray(status.parameters?.required_status_checks)
    || workflows && !Array.isArray(workflows.parameters?.workflows)) fail('BASE_PARAMETERS');
  const checks = structuredClone(status?.parameters.required_status_checks ?? []);
  for (const context of ['SPLRAD Validation', 'SPLRAD PR Title']) {
    const existing = checks.filter(check => check.context === context);
    if (existing.length > 1 || existing.some(check => check.integration_id !== integration)) fail('CHECK_COLLISION');
    if (!existing.length) checks.push({ context, integration_id: integration });
  }
  const workflowRows = structuredClone(workflows?.parameters.workflows ?? []);
  const matching = workflowRows.filter(row => row.repository_id === 1296724484 && row.path === '.github/workflows/pr-validation-native.yml');
  if (matching.length > 1) fail('WORKFLOW_COLLISION');
  const binding = { repository_id: 1296724484, path: '.github/workflows/pr-validation-native.yml', sha: policySha };
  if (matching.length) Object.assign(matching[0], binding); else workflowRows.push(binding);
  if (matching[0]) delete matching[0].ref;
  const foundation = { name: base.name, target: 'branch', enforcement: 'active', conditions: {
    repository_name: structuredClone(allRepositories), ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
  }, bypass_actors: [], rules: structuredClone(base.rules.filter(item => !controlled.includes(item.type))) };
  for (const type of ['deletion', 'non_fast_forward', 'required_linear_history'])
    if (!foundation.rules.some(item => item.type === type)) foundation.rules.push(rule(type));
  foundation.rules.push(approval(0, true), { type: 'required_status_checks', parameters: {
    ...(status?.parameters ?? {}), strict_required_status_checks_policy: true, required_status_checks: checks,
  } }, { type: 'workflows', parameters: { ...(workflows?.parameters ?? {}), do_not_enforce_on_create: true, workflows: workflowRows } });
  const independent = nativeRule('SPLRAD PR Approval', ['~DEFAULT_BRANCH'], [], [
    { actor_id: team.id, actor_type: 'Team', bypass_mode: 'pull_request' },
  ]);
  independent.rules = [approval(1, false)];
  const state = ['refs/heads/steward/release-state', 'refs/heads/steward/automation-health'];
  const governance = ['refs/heads/steward/governance-state'];
  const build = ['refs/heads/steward/build/*'];
  const pr = ['refs/heads/steward/managed-sync', 'refs/heads/steward/release-candidate'];
  const runtime = [
    nativeRule('steward-state-writer', state, ['creation', 'update'], [actor(4243096)]),
    nativeRule('steward-governance-writer', governance, ['creation', 'update'], [actor(4243096), actor(governanceApp.id)]),
    nativeRule('steward-ref-creator', [...build, ...pr], ['creation'], [actor(4243096)]),
    nativeRule('steward-ref-integrity', [...state, ...governance, ...pr], ['non_fast_forward', 'deletion'], []),
    nativeRule('steward-build-immutable', build, ['update', 'deletion'], []),
  ];
  const legacy = []; const seen = new Set();
  for (const item of legacyCandidates) {
    if (!id(item.repositoryId) || typeof item.branch !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(item.branch)
      || item.branch.includes('..') || item.branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
      || pr.includes(`refs/heads/${item.branch}`) || seen.has(`${item.repositoryId}:${item.branch}`)) fail('LEGACY_BRANCH');
    seen.add(`${item.repositoryId}:${item.branch}`);
    for (const [suffix, types, bypass] of [['creator', ['creation'], [actor(4243096)]], ['integrity', ['non_fast_forward', 'deletion'], []]]) {
      const entry = nativeRule(`steward-legacy-pr-${item.repositoryId}-${legacy.length}-${suffix}`, [`refs/heads/${item.branch}`], types, bypass);
      entry.conditions = { repository_id: { repository_ids: [item.repositoryId] }, ref_name: entry.conditions.ref_name };
      legacy.push(entry);
    }
  }
  return { foundation, independent, runtime, legacy };
}

/** Check approval constraints from all natively applicable Rulesets and legacy branch protection. */
export function assertApprovalUnion(effectiveRulesets, branchProtection, expectedTeamId) {
  if (!Array.isArray(effectiveRulesets) || !id(expectedTeamId)) fail('EFFECTIVE_RULES');
  const active = effectiveRulesets.filter(entry => entry.enforcement === 'active');
  const bases = active.filter(entry => entry.id === 18883080);
  const independent = active.filter(entry => entry.name === 'SPLRAD PR Approval' && entry.source === 'splrad' && entry.source_type === 'Organization');
  if (bases.length !== 1 || independent.length !== 1 || !Array.isArray(bases[0].bypass_actors) || bases[0].bypass_actors.length
    || bases[0].source !== 'splrad' || bases[0].source_type !== 'Organization'
    || independent[0].bypass_actors?.length !== 1 || independent[0].bypass_actors[0].actor_id !== expectedTeamId
    || independent[0].bypass_actors[0].actor_type !== 'Team' || independent[0].bypass_actors[0].bypass_mode !== 'pull_request') fail('BYPASS');
  for (const entry of [bases[0], independent[0]]) {
    const c = entry.conditions;
    if (entry.target !== 'branch' || c?.repository_name?.include?.length !== 1 || c.repository_name.include[0] !== '~ALL'
      || c.repository_name.exclude?.length !== 0 || c.repository_name.protected !== false
      || c.ref_name?.include?.length !== 1 || c.ref_name.include[0] !== '~DEFAULT_BRANCH' || c.ref_name.exclude?.length !== 0) fail('SCOPE');
  }
  for (const entry of active) {
    if (!Array.isArray(entry.rules)) fail('EFFECTIVE_RULES');
    for (const r of entry.rules.filter(value => value.type === 'pull_request')) {
      const p = r.parameters; const special = entry === independent[0];
      if (!p || p.required_approving_review_count !== (special ? 1 : 0) || p.require_code_owner_review !== false
        || p.require_last_push_approval !== false || p.require_extra_approval_for_unattributed_changes !== false
        || !Array.isArray(p.required_reviewers) || p.required_reviewers.length) fail('EXTRA_APPROVAL');
      if (entry === bases[0] && (p.dismiss_stale_reviews_on_push !== true || p.required_review_thread_resolution !== true)) fail('THREADS');
      if (special && (p.dismiss_stale_reviews_on_push !== true || p.required_review_thread_resolution !== false)) fail('THREADS');
      if ((special || entry === bases[0]) && (p.allowed_merge_methods?.length !== 1 || p.allowed_merge_methods[0] !== 'squash')) fail('MERGE_METHOD');
    }
  }
  if (bases[0].rules.filter(r => r.type === 'pull_request').length !== 1 || independent[0].rules.filter(r => r.type === 'pull_request').length !== 1) fail('MISSING_APPROVAL');
  // null is allowed only for a confirmed native 404; callers must not convert permission/read errors.
  if (branchProtection !== null) {
    if (!branchProtection || !Object.hasOwn(branchProtection, 'required_pull_request_reviews')) fail('LEGACY_UNKNOWN');
    const p = branchProtection.required_pull_request_reviews;
    if (p && (p.required_approving_review_count !== 0 || p.require_code_owner_reviews !== false || p.require_last_push_approval !== false)) fail('LEGACY_APPROVAL');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw Error('Usage: prepare-governance.mjs native-snapshot.json native-drafts.json');
  const drafts = prepareGovernance(JSON.parse(await readFile(input, 'utf8')));
  await writeFile(output, JSON.stringify(drafts, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
