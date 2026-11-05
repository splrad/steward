import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it.each([
  ['release.yml', 'release-coordinator', 'steward-release'],
  ['quality-language-summary.yml', 'quality-summary', 'steward-release-notes'],
])('%s routes its native job token only into its model consumer step', async (file, key, environment) => {
  const workflow = parse(await readFile(`.github/workflows/${file}`, 'utf8'));
  const job = workflow.jobs[key];
  expect(job.environment).toEqual({ name: environment, deployment: false });
  expect(job.if).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  expect(workflow.env).toBeUndefined();
  expect(job.env).toBeUndefined();
  const consumers = job.steps.filter((step: {env?: Record<string, string>}) => step.env?.STEWARD_COPILOT_TOKEN);
  expect(consumers).toHaveLength(1);
  expect(consumers[0].env.STEWARD_COPILOT_TOKEN).toBe('${{ github.token }}');
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

it('only the two fixed model jobs receive native Copilot permission', async () => {
  const consumers: string[] = [];
  for (const file of await readdir('.github/workflows')) {
    if (!/\.ya?ml$/.test(file)) continue;
    const workflow = parse(await readFile(`.github/workflows/${file}`, 'utf8'));
    expect(workflow.permissions?.['copilot-requests']).toBeUndefined();
    for (const [key, job] of Object.entries(workflow.jobs) as [string, {permissions?: Record<string, string>}][]) {
      if (job.permissions?.['copilot-requests']) consumers.push(`${file}/${key}`);
    }
  }
  expect(consumers.sort()).toEqual(['quality-language-summary.yml/quality-summary', 'release.yml/release-coordinator']);
});
