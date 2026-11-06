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
it('connects the fixed coordinator and independent native health job within the 45 minute wake', async () => {
  const d = await load('release.yml');
  expect(Object.keys(d.jobs)).toEqual(['release-coordinator','automation-health']);
  expect(d.on.schedule).toEqual([{cron:'3-58/5 * * * *'}]);
  expect(d.concurrency).toEqual({group:'steward-release-coordinator','cancel-in-progress':false});
  expect(d.jobs['release-coordinator']['timeout-minutes']).toBe(45);
  expect(d.jobs['release-coordinator'].steps.at(-1).run).toBe('node scripts/release-coordinator.mjs');
  expect(JSON.stringify(d.jobs['release-coordinator'])).not.toMatch(/release-plan|release-please-action|matrix|upload-artifact/);
  const managed=await load('sync-managed.yml');
  expect(managed.on.schedule).toEqual([{cron:'37 * * * *'}]);
  for(const document of [d,managed]) {
    for(const [id,business] of Object.entries(document.jobs) as [string,any][])if(id!=='automation-health') {
      expect([business.needs??[]].flat()).not.toContain('automation-health');
    }
    const job=document.jobs['automation-health'];
    expect(job.needs).toBeUndefined();expect(job['timeout-minutes']).toBe(5);
    expect(job.permissions).toEqual({contents:'read',actions:'write',issues:'write'});
    expect(job.concurrency).toEqual({group:'steward-automation-health','cancel-in-progress':false});
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|checkout|mise|packages\/runner/);
  }
  expect((await load('update-dependencies.yml')).jobs['automation-health']).toBeUndefined();
  const behavior=(job:unknown)=>JSON.parse(JSON.stringify(job,(_key,value)=>typeof value==='string'?value.split('\n').filter(line=>!/^\s*#/.test(line)).join('\n'):value));
  const release=behavior(d.jobs['automation-health']),sync=behavior(managed.jobs['automation-health']);
  expect(sync.if).toBe(release.if+' && !inputs.bootstrap_only');
  delete release.if;delete sync.if;expect(release).toEqual(sync);
});
