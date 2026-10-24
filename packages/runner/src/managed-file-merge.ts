import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

export interface DependencyField { jobId: string; stepId: string; path: ['uses'] | ['with', string] }
export interface ManagedFileRule {
  source: string; destination: string; mode: 'whole' | 'section';
  startMarker?: string; endMarker?: string; dependencyFields: DependencyField[];
}
export type MergeText = (current: string, base: string, next: string) => Promise<string>;
export const mergeTextWithGit: MergeText = async (current, base, next) => {
  const directory = await mkdtemp(join(tmpdir(), 'steward-merge-file-'));
  try {
    const paths = ['current', 'base', 'next'].map(name => join(directory, name));
    await Promise.all([current, base, next].map((text, i) => writeFile(paths[i]!, text, { flag: 'wx' })));
    const result = spawnSync('git', ['merge-file', '-p', '--diff3', '-L', 'CURRENT', '-L', 'BASE', '-L', 'NEW', ...paths],
      { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('MANAGED_SYNC_CONFLICT');
    return result.stdout;
  } finally { await rm(directory, { recursive: true, force: true }); }
};
function fail(reason: string): never { throw new Error(`MANAGED_SYNC: ${reason}`); }
function section(text: string, rule: ManagedFileRule): { prefix: string; body: string; suffix: string } {
  const { startMarker: start, endMarker: end } = rule;
  if (!start || !end || start === end || start.includes('\n') || end.includes('\n')) fail('invalid section markers');
  const begin = text.indexOf(start), finish = text.indexOf(end);
  if (begin < 0 || finish <= begin || text.indexOf(start, begin + start.length) >= 0 || text.indexOf(end, finish + end.length) >= 0) fail('ambiguous section markers');
  for (const [offset, marker] of [[begin, start], [finish, end]] as const) {
    if (offset > 0 && text[offset - 1] !== '\n' || !['\n', '\r', undefined].includes(text[offset + marker.length])) fail('section marker must occupy its own line');
  }
  const startOffset = begin + start.length;
  if (/<!--\s*(?:begin|end)(?:\s|:)/i.test(text.slice(startOffset, finish))) fail('nested section markers');
  return { prefix: text.slice(0, startOffset), body: text.slice(startOffset, finish), suffix: text.slice(finish) };
}
function dependencySpans(text: string, fields: DependencyField[]) {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length || !isMap(document.contents)) fail('invalid workflow YAML');
  const spans = fields.map(field => {
    if (!field.path.length || !((field.path.length === 1 && field.path[0] === 'uses')
      || (field.path.length === 2 && field.path[0] === 'with'))) fail('invalid dependency field');
    const steps = document.getIn(['jobs', field.jobId, 'steps'], true);
    if (!isSeq(steps)) fail('missing dependency job');
    const matches = steps.items.filter(step => isMap(step) && step.get('id') === field.stepId);
    if (matches.length !== 1 || !isMap(matches[0])) fail('missing or duplicate dependency step');
    const node = matches[0].getIn(field.path, true);
    if (!isScalar(node) || !node.range || typeof node.value !== 'string') fail('missing dependency scalar');
    if (field.path[0] === 'uses' && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(node.value)) fail('dependency action must be pinned');
    return { start: node.range[0], end: node.range[1], bytes: text.slice(node.range[0], node.range[1]) };
  });
  if (new Set(spans.map(span => span.start)).size !== spans.length) fail('duplicate dependency field');
  return spans;
}
/** Preserve the product-owned scalar representation before Git's three-way merge. */
export async function mergeManagedFile(current: string, base: string, next: string, rule: ManagedFileRule,
  merge: MergeText = mergeTextWithGit): Promise<string> {
  if (rule.mode === 'section') {
    if (rule.dependencyFields.length) fail('workflow dependencies require whole-file ownership');
    const a = section(current, rule), b = section(base, rule), c = section(next, rule);
    return a.prefix + await merge(a.body, b.body, c.body) + a.suffix;
  }
  if (rule.mode !== 'whole') fail('unknown merge mode');
  if (rule.dependencyFields.length) {
    const adopted = dependencySpans(current, rule.dependencyFields);
    const normalize = (text: string) => {
      const spans = dependencySpans(text, rule.dependencyFields);
      for (const [index, span] of spans.map((span, index) => [index, span] as const).sort((a, b) => b[1].start - a[1].start)) {
        text = text.slice(0, span.start) + adopted[index]!.bytes + text.slice(span.end);
      }
      return text;
    };
    base = normalize(base); next = normalize(next);
  }
  return merge(current, base, next);
}
