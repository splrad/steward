import { isMap, isScalar, LineCounter, parseDocument } from 'yaml';
import { resolve } from 'node:path';

const knownMessage = 'unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"';
export interface QueueLocation { filepath: string; line: number; column: number }

/** Validate the native queue extension before matching a parser diagnostic. */
export function validateQueueSyntax(filepath: string, text: string): QueueLocation[] {
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  if (document.errors.length) throw new Error(`queue compatibility: invalid YAML: ${document.errors.join('; ')}`);
  const locations: QueueLocation[] = [];
  function check(value: unknown) {
    if (!isMap(value)) return;
    const pair = value.items.find(item => isScalar(item.key) && item.key.value === 'queue');
    if (!pair) return;
    if (!isScalar(pair.value) || !['single', 'max'].includes(pair.value.value as string)) {
      throw new Error('queue compatibility: queue must be literal single or max');
    }
    const cancel = value.get('cancel-in-progress', true);
    if (pair.value.value === 'max' && cancel !== undefined && (!isScalar(cancel) || cancel.value !== false)) {
      throw new Error('queue compatibility: max requires absent or literal false cancel-in-progress');
    }
    if (!isScalar(pair.key) || !pair.key.range) throw new Error('queue compatibility: missing key location');
    const position = lines.linePos(pair.key.range[0]);
    locations.push({ filepath, line: position.line, column: position.col });
  }
  if (isMap(document.contents)) {
    check(document.contents.get('concurrency', true));
    const jobs = document.contents.get('jobs', true);
    if (isMap(jobs)) for (const job of jobs.items) {
      if (isMap(job.value)) check(job.value.get('concurrency', true));
    }
  }
  return locations;
}

/** Unknown output, errors, locations and exit statuses always fail closed. */
export function acceptActionlintResult(status: number | null, stdout: string, stderr: string,
  locations: readonly QueueLocation[], cwd: string): boolean {
  if (stderr.trim() || (status !== 0 && status !== 1)) return false;
  let diagnostics: unknown;
  try { diagnostics = JSON.parse(stdout); } catch { return false; }
  // actionlint renders its empty error slice as null.
  if (diagnostics === null) return status === 0;
  if (!Array.isArray(diagnostics)) return false;
  if (!diagnostics.length) return status === 0;
  if (status !== 1) return false;
  const seen = new Set<string>();
  return diagnostics.every(item => {
    if (!item || item.kind !== 'syntax-check' || item.message !== knownMessage) return false;
    if (typeof item.filepath !== 'string') return false;
    const match = locations.find(location => resolve(location.filepath) === resolve(cwd, item.filepath)
      && location.line === item.line && location.column === item.column);
    const key = JSON.stringify(match);
    if (!match || seen.has(key)) return false;
    seen.add(key); return true;
  }) && seen.size === locations.length;
}
