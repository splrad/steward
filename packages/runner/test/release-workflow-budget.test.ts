import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { nativeInspectionTimeoutMs } from '../src/release-native.js';
const load = async (name: string) => YAML.parse(await readFile('.github/workflows/' + name, 'utf8'));
it('contains the native product build and inspection budgets within hosted job limits', async () => {
  const d = await load('product-release.yml');
  const product = YAML.parse(await readFile('templates/release/steward-release-publish.yml', 'utf8'));
  expect(product.jobs.build['timeout-minutes']).toBeGreaterThanOrEqual(30);
  // The first accepted product has three delivered assets, each with a bounded native inspector.
  expect(d.jobs.inspect['timeout-minutes'] * 60_000).toBeGreaterThanOrEqual(3 * nativeInspectionTimeoutMs + 10 * 60_000);
  for (const job of [...Object.values(d.jobs), ...Object.values(product.jobs)].filter((job: any) => !job.uses) as any[]) {
    expect(Number.isInteger(job['timeout-minutes'])).toBe(true);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(360);
    expect(job['continue-on-error']).toBeUndefined();
  }
});
