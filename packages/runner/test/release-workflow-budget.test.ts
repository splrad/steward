import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { nativeInspectionTimeoutMs } from '../src/release-native.js';
const load = async (name: string) => YAML.parse(await readFile('.github/workflows/' + name, 'utf8'));
it('contains the native product build and inspection budgets within hosted job limits', async () => {
  const d = await load('product-release.yml');
  expect(d.jobs.build['timeout-minutes']).toBeGreaterThanOrEqual(300 + 15);
  // The first accepted product has three delivered assets, each with a bounded native inspector.
  expect(d.jobs.inspect['timeout-minutes'] * 60_000).toBeGreaterThanOrEqual(3 * nativeInspectionTimeoutMs + 10 * 60_000);
  for (const job of Object.values(d.jobs) as any[]) {
    expect(Number.isInteger(job['timeout-minutes'])).toBe(true);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(360);
    expect(job['continue-on-error']).toBeUndefined();
  }
});
it('uses only native planning jobs and keeps producer execution in the product run', async () => {
  const d = await load('release.yml');
  expect(Object.keys(d.jobs)).toEqual(['targets', 'plan']);
  expect(JSON.stringify(d)).not.toMatch(/release-candidate|release-produce|release-build|workflow_run/);
  expect(d.jobs.plan.steps.find((step: any) => step.id === 'release').with['skip-github-pull-request']).toBe(true);
  expect(d.jobs.plan.steps.find((step: any) => step.id === 'prepare').with['skip-github-release']).toBe(true);
});
