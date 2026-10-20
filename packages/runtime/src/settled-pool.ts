/** Finish independent items even when one fails; a later sweep can retry failures. */
export async function settledPool<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>): Promise<PromiseSettledResult<void>[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid pool concurrency');
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try { await run(items[index]!); results[index] = { status: 'fulfilled', value: undefined }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}
