import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it.each([
  ['release.yml', 'release-coordinator', 'steward-release'],
  ['quality-language-summary.yml', 'quality-summary', 'steward-release-notes'],
  ['ai-identity-acceptance.yml', 'quality', 'steward-release-notes'],
  ['ai-identity-acceptance.yml', 'release', 'steward-release'],
])('%s routes its native job token only into its model consumer step', async (file, key, environment) => {
  const workflow = parse(await readFile(`.github/workflows/${file}`, 'utf8'));
  const job = workflow.jobs[key];
  expect(job.environment).toEqual({ name: environment, deployment: false });
  if (file === 'ai-identity-acceptance.yml') {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.authorize_two_requests.default).toBe(false);
    for (const guard of ["github.repository == 'splrad/steward'", "github.repository_id == '1296724484'", "github.ref == 'refs/heads/main'",
      'github.run_attempt == 1', 'inputs.authorize_two_requests', 'inputs.approved_sha == github.sha', 'github.workflow_sha == github.sha']) {
      expect(job.if).toContain(guard);
    }
    expect(workflow.jobs.release.needs).toBe('quality');
  } else {
    expect(job.if).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  }
  expect(workflow.env).toBeUndefined();
  expect(job.env).toBeUndefined();
  const consumers = job.steps.filter((step: {env?: Record<string, string>}) => step.env?.STEWARD_COPILOT_TOKEN);
  expect(consumers).toHaveLength(1);
  expect(consumers[0].env.STEWARD_COPILOT_TOKEN).toBe('${{ github.token }}');
  if (file === 'ai-identity-acceptance.yml') {
    expect(consumers[0].run).toBe(`node tools/quality-language/identity-acceptance.mjs ${key}`);
    expect(JSON.stringify(job)).not.toMatch(/secrets\./);
  }
  expect(job.permissions['copilot-requests']).toBe('write');
  expect(workflow.permissions['copilot-requests']).toBeUndefined();
  expect(Object.keys(workflow.on).every(event => ['push', 'schedule', 'workflow_dispatch'].includes(event))).toBe(true);
  for (const step of job.steps.filter((step: unknown) => step !== consumers[0])) {
    expect(JSON.stringify(step)).not.toMatch(/secrets\./);
  }
  if (workflow.jobs['automation-health']) {
    expect(workflow.jobs['automation-health'].environment).toBeUndefined();
    expect(JSON.stringify(workflow.jobs['automation-health'])).not.toMatch(/secrets\./);
  }
});

it('only the two production and two explicitly gated acceptance jobs receive native Copilot permission', async () => {
  const consumers: string[] = [];
  for (const file of await readdir('.github/workflows')) {
    if (!/\.ya?ml$/.test(file)) continue;
    const workflow = parse(await readFile(`.github/workflows/${file}`, 'utf8'));
    expect(workflow.permissions?.['copilot-requests']).toBeUndefined();
    for (const [key, job] of Object.entries(workflow.jobs) as [string, {permissions?: Record<string, string>}][]) {
      if (job.permissions?.['copilot-requests']) consumers.push(`${file}/${key}`);
    }
  }
  expect(consumers.sort()).toEqual(['ai-identity-acceptance.yml/quality', 'ai-identity-acceptance.yml/release',
    'quality-language-summary.yml/quality-summary', 'release.yml/release-coordinator']);
});
