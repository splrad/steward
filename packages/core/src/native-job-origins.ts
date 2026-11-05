import type { NativeJob } from './native-evidence.js';

export interface NativeJobAttempt { attempt: number; jobs: NativeJob[] }
export interface NativeJobOrigin { job: NativeJob; origin: NativeJob }
/** Native job/step ends have second precision; log receipts retain fractions.
 * Accept the final native second, without extending a finer timestamp. */
export function withinNativeJobWindow(at: string, start: string, end: string | null): boolean {
  const value = Date.parse(at), first = Date.parse(start), last = end === null ? null : Date.parse(end);
  return Number.isFinite(value) && Number.isFinite(first) && value >= first && (last === null
    || Number.isFinite(last) && (last % 1000 === 0 ? value < last + 1000 : value <= last));
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`NATIVE_EVIDENCE: job origin ${reason}`);
}
const execution = (job: NativeJob) => [job.runId, job.headSha, job.name, job.status, job.conclusion,
  job.startedAt, job.completedAt, job.steps];

/** Attempt endpoints can assign new IDs to retained executions. Keep raw rows,
 * but attribute identical terminal native times/steps to their original attempt.
 * Callers must supply complete, source-checked pages for every earlier attempt. */
export function nativeJobOrigins(attempts: NativeJobAttempt[]): NativeJobOrigin[] {
  const result: NativeJobOrigin[] = [], originals: NativeJob[] = [], ids = new Map<number, NativeJob>();
  let source: [number, string] | undefined;
  for (const [index, batch] of attempts.entries()) {
    check(batch.attempt === index + 1 && Array.isArray(batch.jobs), 'incomplete attempts');
    check(new Set(batch.jobs.map(job => job.id)).size === batch.jobs.length, 'duplicate ID');
    const added: NativeJob[] = [];
    for (const job of batch.jobs) {
      check(Number.isSafeInteger(job.id) && job.id > 0 && job.runAttempt === batch.attempt, 'identity');
      source ??= [job.runId, job.headSha];
      check(same(source, [job.runId, job.headSha]), 'source');
      const priorId = ids.get(job.id);
      if (priorId) check(same(execution(priorId), execution(job)), 'changed ID');
      const terminal = job.status === 'completed' && job.startedAt !== null && job.completedAt !== null;
      const matching = terminal ? originals.filter(old => old.name === job.name && old.startedAt === job.startedAt
        && old.completedAt === job.completedAt) : [];
      check(matching.length <= 1, 'ambiguous execution');
      if (matching.length) check(same(execution(matching[0]!), execution(job)), 'changed execution');
      const origin = matching[0] ?? priorId ?? job;
      if (origin === job) added.push(job);
      result.push({ job, origin }); ids.set(job.id, origin);
    }
    originals.push(...added);
  }
  return result;
}

export function originalJobExecutions(attempts: NativeJobAttempt[]): NativeJob[] {
  return nativeJobOrigins(attempts).filter(({ job, origin }) => job === origin).map(({ job }) => job);
}
