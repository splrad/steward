import { ReleaseSourceError } from '../../core/src/release-notes-input.js';

interface SourceBudget { commits: number; requests: number; concurrency: number; intervalMs: number; timeoutMs: number; reserve: number }
export const releaseSourceBudget: Readonly<SourceBudget> = Object.freeze({ commits: 120, requests: 1800, concurrency: 4, intervalMs: 200, timeoutMs: 8 * 60_000, reserve: 100 });
/** One transport per invocation, shared by initial collection and final reread, including pagination. */
export function budgetReleaseSourceTransport(transport: typeof fetch = fetch, limits = releaseSourceBudget): typeof fetch {
  const deadline = Date.now() + limits.timeoutMs;
  let count = 0; let active = 0; let nextStart = 0; let stopped: Error | undefined;
  let remaining = Infinity;
  const waiters: Array<() => void> = [];
  const fail = (detail: string): never => { stopped ??= new ReleaseSourceError('RN_SOURCE_INCOMPLETE', `release API budget: ${detail}`); throw stopped; };
  return async (input, init) => {
    if (active >= limits.concurrency) await new Promise<void>(resolve => waiters.push(resolve));
    else active++;
    try {
      if (stopped) throw stopped;
      if ((init?.method ?? 'GET') !== 'GET') return fail('read-only transport');
      const wait = Math.max(0, nextStart - Date.now());
      nextStart = Math.max(Date.now(), nextStart) + limits.intervalMs;
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      if (stopped) throw stopped;
      const time = deadline - Date.now();
      if (time <= 0) return fail('deadline');
      if (count >= limits.requests || remaining <= limits.reserve) return fail('request count or remaining quota');
      count++; remaining--;
      const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(time)]) : AbortSignal.timeout(time);
      let response: Response;
      try {
        response = await transport(input, { ...init, signal });
        // Hold the concurrency slot and deadline through body consumption, not just headers.
        const bytes = await response.arrayBuffer();
        if (Date.now() >= deadline) return fail('deadline');
        const value = response.headers.get('x-ratelimit-remaining');
        if (value !== null && /^\d+$/.test(value)) remaining = Math.min(remaining, Number(value));
        if (response.status === 403 || response.status === 429) return fail(`HTTP ${response.status}`);
        return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        if (signal.aborted) return fail('deadline or cancellation');
        stopped ??= error instanceof Error ? error : new Error(String(error));
        throw stopped;
      }
    } finally {
      const next = waiters.shift();
      if (next) next(); else active--;
    }
  };
}
