import { expect, it } from 'vitest';
import { settledPool } from '../src/settled-pool.js';

it('bounds 101 repository checks and continues after a rate-limited repository', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => i);
  let active = 0, peak = 0;
  const visited: number[] = [];
  const results = await settledPool(ids, 4, async id => {
    active++; peak = Math.max(peak, active); visited.push(id);
    await Promise.resolve(); await Promise.resolve();
    active--;
    if (id === 1) throw new Error('429 retry later');
  });
  expect(peak).toBe(4);
  expect(visited).toEqual(ids);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(100);
  expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('429 retry later') });
  // A subsequent safety sweep retries the source list, including the failed item.
  const retried: number[] = [];
  await settledPool(ids, 4, async id => { retried.push(id); });
  expect(retried).toEqual(ids);
});
