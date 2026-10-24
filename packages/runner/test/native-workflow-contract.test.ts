import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { assertWorkflowDocument } from '../src/workflow-policy.js';
const load = async (name: string) => YAML.parse(await readFile('.github/workflows/' + name, 'utf8'));
it.each(['release.yml', 'sync-managed.yml', 'product-release.yml', 'update-dependencies.yml'])('validates actual %s capability without scan ignores', async name => {
  const d = await load(name);
  expect(() => assertWorkflowDocument('.github/workflows/' + name, d)).not.toThrow();
});
it.each(['identity-permission', 'callback', 'extra-job', 'secret', 'permissions', 'source-checkout', 'policy-checkout', 'overwrite', 'failed-step', 'failed-job', 'verify-needs', 'verify-condition', 'budget', 'attestation', 'queue', 'unknown-input'])('rejects product contract mutation: %s', async variant => {
  const d = await load('product-release.yml');
  if (variant === 'identity-permission') delete d.jobs.identity.permissions['pull-requests'];
  if (variant === 'callback') d.on = { workflow_run: { workflows: ['build'], types: ['completed'] } };
  if (variant === 'extra-job') d.jobs.extra = structuredClone(d.jobs.publish);
  if (variant === 'secret') d.jobs.publish.env = { TOKEN: '${{ secrets.EXTRA }}' };
  if (variant === 'permissions') d.jobs.build.permissions.contents = 'write';
  if (variant === 'source-checkout') d.jobs.publish.steps[0].with.path = 'source';
  if (variant === 'policy-checkout') d.jobs.inspect.steps[0].with.ref = '${{ github.sha }}';
  if (variant === 'overwrite') d.jobs.build.steps.find((s: any) => s.id === 'artifact').with.overwrite = true;
  if (variant === 'failed-step') d.jobs.inspect.steps[0]['continue-on-error'] = true;
  if (variant === 'failed-job') d.jobs.publish['continue-on-error'] = true;
  if (variant === 'verify-needs') d.jobs.verify.needs = ['identity'];
  if (variant === 'verify-condition') d.jobs.verify.if = 'success()';
  if (variant === 'budget') d.jobs.build['timeout-minutes'] = 120;
  if (variant === 'attestation') d.jobs.attest.steps.at(-1).with['subject-path'] = '${{ runner.temp }}/assets/app.exe';
  if (variant === 'queue') d.concurrency.group = 'release-${{ inputs.tag }}';
  if (variant === 'unknown-input') d.on.workflow_call.inputs.token = { required: true, type: 'string' };
  expect(() => assertWorkflowDocument('.github/workflows/product-release.yml', d)).toThrow();
});
it.each(['release.yml', 'sync-managed.yml'])('blocks token scope broadening and guard removal: %s', async name => {
  const d = await load(name), writer = name === 'release.yml' ? 'plan' : 'synchronize';
  for (const variant of ['token', 'guard', 'queue', 'environment']) {
    const candidate = structuredClone(d), job = candidate.jobs[writer];
    if (variant === 'token') delete job.steps.find((s: any) => s.uses?.startsWith('actions/create-github-app-token@')).with.repositories;
    if (variant === 'guard') job.steps = job.steps.filter((s: any) => s.id !== 'write-check');
    if (variant === 'queue') job.concurrency['cancel-in-progress'] = true;
    if (variant === 'environment') delete job.environment;
    expect(() => assertWorkflowDocument('.github/workflows/' + name, candidate)).toThrow();
  }
});

it.each(['missing-recovery', 'overwrite-frozen', 'new-output'])('rejects %s in final artifact recovery', async kind => {
  const d = await load('product-release.yml');
  if (kind === 'missing-recovery') d.jobs.inspect.steps = d.jobs.inspect.steps.filter((step: any) => step.id !== 'recover');
  if (kind === 'overwrite-frozen') delete d.jobs.inspect.steps.find((step: any) => step.id === 'artifact').if;
  if (kind === 'new-output') d.jobs.inspect.outputs.artifact_id = '${{ steps.artifact.outputs.artifact-id }}';
  expect(() => assertWorkflowDocument('.github/workflows/product-release.yml', d, 1296724484)).toThrow();
});

it.each(['order', 'authorization', 'token-condition', 'before', 'write-check', 'after', 'dispatch', 'policy-token'])('rejects release credential regression: %s', async kind => {
  const d = await load('release.yml'), steps = d.jobs.plan.steps;
  if (kind === 'order') { const index = steps.findIndex((s: any) => s.id === 'target-token'); steps.push(...steps.splice(index, 1)); }
  else if (kind === 'authorization') steps.splice(steps.findIndex((s: any) => s.id === 'authorization'), 1);
  else if (kind === 'token-condition') steps.find((s: any) => s.id === 'target-token').if = "steps.before.outputs.needs_write == 'true'";
  else if (kind === 'policy-token') delete steps.find((s: any) => s.id === 'after').env.POLICY_READ_TOKEN;
  else steps.find((s: any) => s.id === kind).env.GH_TOKEN = '${{ github.token }}';
  expect(() => assertWorkflowDocument('.github/workflows/release.yml', d)).toThrow();
});

it.each(['scope', 'cleanup', 'order', 'missing-reader', 'exposure', 'condition'])('rejects rules token boundary regression: %s', async kind => {
  const d = await load('sync-managed.yml'), steps = d.jobs.synchronize.steps;
  const token = steps.find((s: any) => s.id === 'rules-token');
  if (kind === 'scope') token.with['permission-contents'] = 'write';
  if (kind === 'cleanup') token.with['skip-token-revoke'] = true;
  if (kind === 'order') steps.push(...steps.splice(steps.findIndex((s: any) => s.id === 'authorization'), 1));
  if (kind === 'missing-reader') delete steps.find((s: any) => s.id === 'labels').env.RULES_READ_TOKEN;
  if (kind === 'exposure') steps.find((s: any) => s.id === 'apply').env.RULES_READ_TOKEN = '${{ steps.rules-token.outputs.token }}';
  if (kind === 'condition') delete token.if;
  expect(() => assertWorkflowDocument('.github/workflows/sync-managed.yml', d)).toThrow();
});
