function fail(detail: string): never { throw new Error('NATIVE_WORKFLOW: ' + detail); }
const canonical = (v: any): string => JSON.stringify(Array.isArray(v) ? v.map(x => JSON.parse(canonical(x))) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(canonical(v[k]))])) : v ?? null);
function same(actual: any, expected: any, detail: string) { if (canonical(actual) !== canonical(expected)) fail(detail); }
const read = { contents: 'read', actions: 'read' };
export function assertNativeWorkflow(path: string, document: any, repositoryId: number): boolean {
  if (repositoryId !== 1296724484 || !['.github/workflows/product-release.yml', '.github/workflows/release.yml', '.github/workflows/sync-managed.yml', '.github/workflows/update-dependencies.yml'].includes(path)) return false;
  const d = document;
  if (!d || !d.jobs || typeof d.jobs !== 'object') fail('jobs');
  if (Object.keys(d.on ?? {}).some(event => !['workflow_call', 'workflow_dispatch', 'schedule', 'push'].includes(event))) fail('trigger');
  for (const job of Object.values(d.jobs) as any[]) {
    if (!Number.isInteger(job['timeout-minutes']) || job['timeout-minutes'] < 1 || job['timeout-minutes'] > 360 || job['continue-on-error'] !== undefined) fail('job budget or failure suppression');
    if (job.steps?.some((s: any) => s['continue-on-error'] !== undefined)) fail('step failure suppression');
  }
  if (path.endsWith('/product-release.yml')) {
    same(Object.keys(d.jobs), ['identity', 'build', 'collect', 'sign', 'inspect', 'attest', 'publish', 'verify'], 'native release job set');
    same(Object.keys(d.on), ['workflow_call'], 'product trigger');
    const inspect = d.jobs.inspect, recovered = inspect.steps.find((step: any) => step.id === 'recover');
    if (!recovered?.run?.includes('release-pipeline recover --record record.json') || recovered.if !== undefined) fail('frozen final recovery');
    const recoverIndex = inspect.steps.indexOf(recovered);
    for (const step of inspect.steps.filter((step: any) => step.id === 'artifact' || /release-pipeline (download|inspect|seal)/.test(step.run ?? ''))) {
      if (inspect.steps.indexOf(step) <= recoverIndex || step.if !== "steps.recover.outputs.found != 'true'") fail('frozen final regeneration');
    }
    same(inspect.outputs, { artifact_id: '${{ steps.recover.outputs.artifact_id || steps.artifact.outputs.artifact-id }}', digest: '${{ steps.recover.outputs.digest || steps.artifact.outputs.artifact-digest }}' }, 'frozen final outputs');

    same(d.on.workflow_call, { inputs: Object.fromEntries(['unit', 'tag', 'release_id', 'release_pr'].map(key => [key, { required: true, type: 'string' }])) }, 'product inputs');
    same(d.permissions, read, 'product upper scope');
    same(d.concurrency, { group: 'release-publish-${{ github.repository_id }}-${{ inputs.unit }}-${{ inputs.release_id }}', 'cancel-in-progress': false, queue: 'max' }, 'release identity queue');
    const dependencies: Record<string, string[]> = { build: ['identity'], collect: ['identity', 'build'], sign: ['identity', 'collect'], inspect: ['identity', 'collect', 'sign'], attest: ['identity', 'inspect'], publish: ['identity', 'inspect', 'attest'], verify: ['identity', 'build', 'collect', 'sign', 'inspect', 'attest', 'publish'] };
    for (const [name, job] of Object.entries(d.jobs) as [string, any][]) {
      same(job.permissions, name === 'identity' ? { ...read, 'id-token': 'write' } : name === 'attest' ? { ...read, 'id-token': 'write', attestations: 'write' }
        : name === 'publish' ? { ...read, contents: 'write', attestations: 'read' } : name === 'verify' ? { ...read, attestations: 'read' } : read, name + ' permissions');
      if (job.environment !== undefined || /secrets\./.test(JSON.stringify(job))) fail('product secrets/environment');
      same(job['runs-on'], name === 'identity' ? 'ubuntu-24.04' : 'windows-2025', name + ' runner');
      if (name !== 'identity') same(typeof job.needs === 'string' ? [job.needs] : job.needs, dependencies[name], name + ' dependencies');
      for (const step of job.steps) {
        if (step.uses?.startsWith('actions/download-artifact@')) fail('artifact downloads must validate native identity and digest');
        if (step.uses?.startsWith('actions/checkout@')) {
          if (step.with?.path === 'policy') {
            same(step.with.repository, 'splrad/steward', 'policy repository');
            same(step.with.ref, name === 'identity' ? '${{ steps.policy.outputs.sha }}' : '${{ needs.identity.outputs.policy_sha }}', 'policy commit');
          } else {
            if (!['identity', 'build', 'inspect'].includes(name) || step.with?.path !== 'source') fail('product source in privileged job');
            same(step.with.ref, name === 'identity' ? '${{ github.sha }}' : '${{ needs.identity.outputs.source_sha }}', 'source commit');
          }
        }
        if (step.uses?.startsWith('actions/upload-artifact@') && (step.with?.overwrite !== false || step.with?.['if-no-files-found'] !== 'error')) fail('immutable producer artifact');
      }
    }
    if (d.jobs.build['timeout-minutes'] < 315) fail('native build budget');
    if (!String(d.jobs.verify.if).includes('always()') || !d.jobs.verify.steps.some((s: any) => s.run?.includes('release-pipeline gates')) || !d.jobs.verify.steps.some((s: any) => s.run?.includes('release-pipeline verify'))) fail('complete run verification');
    const attest = d.jobs.attest.steps.find((s: any) => s.uses?.startsWith('actions/attest@'));
    same(attest?.with, { 'subject-path': '${{ runner.temp }}/assets/*', 'push-to-registry': false, 'create-storage-record': false }, 'all sealed attestations');
  } else {
    const sync = path.endsWith('/sync-managed.yml'), update = path.endsWith('/update-dependencies.yml'), writer = sync ? 'synchronize' : update ? 'update' : 'plan';
    same(Object.keys(d.jobs), ['targets', writer], 'central job set');
    same(d.permissions, { contents: 'read' }, 'central readonly scope');
    same(d.jobs.targets.if, "github.repository == 'splrad/steward' && github.ref == 'refs/heads/main'", 'trusted central ref');
    const job = d.jobs[writer];
    same(job.concurrency, { group: (sync ? 'managed-sync-' : update ? 'dependency-updates-' : 'release-plan-') + '${{ matrix.repositoryId }}', 'cancel-in-progress': false, queue: 'max' }, 'per repository queue');
    same(job.environment, { name: sync || update ? 'steward-automation' : 'steward-release', deployment: false }, 'writer environment');
    const token = job.steps.find((s: any) => s.uses?.startsWith('actions/create-github-app-token@') && s.id !== 'rules-token');
    same(token?.with, { 'app-id': '4243096', 'private-key': '${{ secrets.STEWARD_APP_PRIVATE_KEY }}', owner: 'splrad', repositories: sync ? '${{ steps.authorization.outputs.repository }}' : '${{ matrix.repository }}',
      'permission-contents': 'write', 'permission-pull-requests': 'write', ...(sync ? { 'permission-workflows': 'write' } : update ? { 'permission-issues': 'write', 'permission-workflows': 'write', 'permission-actions': 'read', 'permission-checks': 'read', 'permission-metadata': 'read' } : { 'permission-issues': 'write', 'permission-actions': 'write' }) }, 'single repository token');
    if (!token.if || !job.steps.some((s: any) => s.id === 'write-check')) fail('prewrite authority');
    if (update) {
      const step = job.steps.find((s: any) => s.id === 'renovate');
      if (!/^ghcr\.io\/renovatebot\/renovate:[0-9]+\.[0-9]+\.[0-9]+@sha256:[a-f0-9]{64}$/.test(step?.with?.['renovate-image'] ?? '') || step.with['mount-docker-socket'] !== false
        || step.with.configurationFile !== 'config/renovate/global.cjs' || step.env?.MISE_SAFE !== '1' || step.env?.RENOVATE_REPOSITORIES !== '${{ matrix.fullName }}' || step.if !== "steps.write-check.outputs.enabled == 'true'") fail('Renovate execution boundary');
      if (!job.steps.some((s: any) => s.if === "always() && steps.write-check.outputs.enabled == 'true'" && s.run === 'node scripts/verify-renovate-log.mjs /tmp/steward-renovate.jsonl')) fail('Renovate skip detection');
    } else if (!sync) {
      const ids = ['authorization', 'target-token', 'before', 'write-check', 'release', 'after', 'prepare', 'dispatch'];
      const positions = ids.map(id => {
        const matches = job.steps.filter((step: any) => step.id === id);
        if (matches.length !== 1) fail('release credential sequence');
        return job.steps.indexOf(matches[0]);
      });
      if (positions.some((index: number, offset: number) => offset > 0 && index <= positions[offset - 1]!)) fail('release credential sequence');
      const authorization = job.steps[positions[0]!];
      if (authorization.env?.GH_TOKEN !== '${{ github.token }}' || authorization.env?.POLICY_READ_TOKEN !== undefined
        || !authorization.run?.includes('release-plan preflight ') || authorization.if !== undefined
        || token.if !== "steps.authorization.outputs.enabled == 'true'") fail('release token authorization');
      for (const id of ['before', 'write-check', 'after', 'dispatch']) {
        const step = job.steps.find((step: any) => step.id === id);
        if (step.env?.GH_TOKEN !== '${{ steps.target-token.outputs.token }}' || step.env?.POLICY_READ_TOKEN !== '${{ github.token }}'
          || step.if !== "steps.target-token.outputs.token != ''") fail('release credential scope');
      }
      const release = job.steps.find((s: any) => s.id === 'release'), prepare = job.steps.find((s: any) => s.id === 'prepare');
      if (release?.with?.['skip-github-pull-request'] !== true || prepare?.with?.['skip-github-release'] !== true || release.with['skip-github-release'] !== undefined || prepare.with['skip-github-pull-request'] !== undefined) fail('release and PR phases');
      if (job.steps.findIndex((s: any) => s.id === 'after') <= job.steps.indexOf(release) || job.steps.indexOf(prepare) <= job.steps.findIndex((s: any) => s.id === 'after')) fail('release readback before PR');
    } else {
      const authorization = job.steps.find((s: any) => s.id === 'authorization');
      const rulesToken = job.steps.find((s: any) => s.id === 'rules-token');
      same(rulesToken?.with, { 'app-id': '4243096', 'private-key': '${{ secrets.STEWARD_APP_PRIVATE_KEY }}', owner: 'splrad',
        repositories: '${{ steps.authorization.outputs.repository }}', 'permission-administration': 'write' }, 'rules token scope and cleanup');
      if (!rulesToken.uses?.startsWith('actions/create-github-app-token@') || rulesToken.if !== "steps.authorization.outputs.enabled == 'true'"
        || authorization?.if !== undefined || authorization?.env?.GH_TOKEN !== '${{ github.token }}'
        || !authorization?.run?.includes('managed-sync authorize ') || job.steps.indexOf(authorization) >= job.steps.indexOf(rulesToken)) fail('rules token authorization');
      const consumers = job.steps.filter((s: any) => /managed-sync (preflight|labels) /.test(s.run ?? ''));
      if (consumers.length !== 4 || consumers.some((s: any) => job.steps.indexOf(s) <= job.steps.indexOf(rulesToken))) fail('rules reader sequence');
      for (const step of job.steps) {
        if (consumers.includes(step)) {
          if (step.env?.RULES_READ_TOKEN !== '${{ steps.rules-token.outputs.token }}'
            || step.env?.RULES_READ_REPOSITORY !== '${{ steps.authorization.outputs.full_name }}') fail('rules reader credential');
        } else if (JSON.stringify(step).includes('steps.rules-token.outputs.token')) fail('rules token exposure');
      }
      if (job.steps.find((s: any) => s.id === 'preflight')?.if !== "steps.authorization.outputs.enabled == 'true'") fail('rules preflight authorization');
      const pr = job.steps.find((s: any) => s.uses?.startsWith('peter-evans/create-pull-request@'));
      if (pr?.with?.branch !== 'steward/managed-sync' || pr.with.base !== 'main' || pr.with['delete-branch'] !== false || pr.with['sign-commits'] !== true || pr.with['add-paths'] !== '${{ steps.apply.outputs.add_paths }}' || !pr.if?.includes('steps.write-check.outputs.enabled')) fail('managed branch write');
    }
  }
  return true;
}
