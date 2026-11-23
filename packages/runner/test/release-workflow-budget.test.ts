import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
it('contains the product template build budgets within hosted job limits', async () => {
  const product = YAML.parse(await readFile('templates/release/steward-release-publish.yml', 'utf8'));
  expect(product.jobs.build['timeout-minutes']).toBeGreaterThanOrEqual(30);
  for (const job of Object.values(product.jobs).filter((job: any) => !job.uses) as any[]) {
    expect(Number.isInteger(job['timeout-minutes'])).toBe(true);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(360);
    expect(job['continue-on-error']).toBeUndefined();
  }
});
