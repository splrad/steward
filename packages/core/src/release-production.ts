import { personalizedSections } from './release-personalization.js';
import { decodeBuildJson } from './build-manifest.js';
import { canonicalReleaseJson, contributorMarkdown, receiptDigest, releaseAssert, releaseDigest, validateCandidateNotes, type FrozenRelease } from './release-note-receipt.js';

export const releaseCategories = ['安全', '移除', '即将停用', '新增', '变更', '修复'] as const;
export interface GeneratedRelease {
  userNotes: { upgrade: string[]; changes: { category: typeof releaseCategories[number]; text: string }[] };
  reviewEvidence: { internalChanges: string[]; unknowns: string[] };
}
function exact(value: any, keys: string[]): void {
  releaseAssert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(','), 'GENERATION_FIELDS');
}
function prose(value: unknown): asserts value is string {
  releaseAssert(typeof value === 'string' && value.length > 0 && value.length <= 4000 && value.trim() === value
    && !/[\r\n<>\[\]`]|https?:|github\.com/i.test(value), 'GENERATION_PROSE');
}
/** One plain JSON object, or one explicit json fence; no surrounding commentary. */
export function parseGeneratedRelease(bytes: Uint8Array): GeneratedRelease {
  releaseAssert(bytes.byteLength <= 64 * 1024, 'GENERATION_LIMIT');
  let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  text = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (text.startsWith('```json\n') && text.endsWith('\n```')) text = text.slice(8, -4);
  const result = decodeBuildJson(Buffer.from(text)) as GeneratedRelease;
  exact(result, ['userNotes', 'reviewEvidence']); exact(result.userNotes, ['upgrade', 'changes']); exact(result.reviewEvidence, ['internalChanges', 'unknowns']);
  for (const items of [result.userNotes.upgrade, result.reviewEvidence.internalChanges, result.reviewEvidence.unknowns]) {
    releaseAssert(Array.isArray(items) && items.length <= 64, 'GENERATION_LIMIT'); items.forEach(prose);
  }
  releaseAssert(Array.isArray(result.userNotes.changes) && result.userNotes.changes.length > 0 && result.userNotes.changes.length <= 128, 'GENERATION_CHANGES');
  for (const change of result.userNotes.changes) { exact(change, ['category', 'text']); releaseAssert(releaseCategories.includes(change.category), 'GENERATION_CATEGORY'); prose(change.text); }
  return result;
}
export function renderGeneratedRelease(value: GeneratedRelease, frozen: FrozenRelease): string {
  parseGeneratedRelease(Buffer.from(canonicalReleaseJson(value)));
  const upgrade = value.userNotes.upgrade.length ? value.userNotes.upgrade.map(t => `> ${t}`).join('\n>\n') : '本次升级无需额外操作。';
  const changes = releaseCategories.flatMap(category => {
    const entries = value.userNotes.changes.filter(c => c.category === category);
    return entries.length ? [`### ${category}\n\n${entries.map(c => `- ${c.text}`).join('\n')}\n\n`] : [];
  }).join('');
  const personal = personalizedSections(frozen);
  const before = personal.filter(s => s.slot === 'beforeActions').map(s => s.markdown).join('');
  const after = personal.filter(s => s.slot === 'afterChanges').map(s => s.markdown).join('');
  const notes = `# ${frozen.title}\n\n## 升级须知\n\n${before}${value.userNotes.upgrade.length ? '> [!IMPORTANT]\n' : ''}${upgrade}\n\n## 更新内容\n\n${changes}${after}${contributorMarkdown(frozen)}## 完整变更\n\n${frozen.compareUrl ? `[查看完整变更](${frozen.compareUrl})` : '首次发布。'}\n`;
  validateCandidateNotes(notes, frozen); return notes;
}
export interface GenerationPlan { schemaVersion: 1; sourceDigest: string; policySha: string; producer: 'copilot-cli-1.0.91'; inputs: string[]; maxCalls: number; callTimeoutMs: 180000; jobTimeoutMs: number }
export function generationPlan(sourceDigest: string, policySha: string, inputs: string[]): GenerationPlan {
  releaseAssert(releaseDigest(sourceDigest) && /^[a-f0-9]{40}$/.test(policySha) && inputs.length > 0 && inputs.length <= 8
    && inputs.every(input => typeof input === 'string' && Buffer.byteLength(input) > 0 && Buffer.byteLength(input) <= 96 * 1024), 'GENERATION_INPUT');
  const maxCalls = 2 * (inputs.length + (inputs.length > 1 ? 1 : 0));
  return { schemaVersion: 1, sourceDigest, policySha, producer: 'copilot-cli-1.0.91', inputs: [...inputs], maxCalls, callTimeoutMs: 180000, jobTimeoutMs: Math.max(600000, maxCalls * 180000 + 120000) };
}
export const generationPlanDigest = (plan: GenerationPlan) => receiptDigest(canonicalReleaseJson(plan));
/** Every retained text object is included, including before-images and reverted commits. */
export function generationInputs(source: any): string[] {
  const { objects, ...metadata } = source;
  const units: unknown[] = [{ metadata }];
  for (const object of objects) {
    const { rawBase64, ...identity } = object;
    if (object.encoding === 'binary') { units.push({ ...identity, unknown: 'Binary object: semantic effects require independent evidence.' }); continue; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(rawBase64, 'base64'));
    // Slice by Unicode code points so a boundary never drops or corrupts a character.
    const points = [...text], total = Math.max(1, Math.ceil(points.length / 12000));
    for (let part = 0; part < total; part++) units.push({ ...identity, part, total, text: points.slice(part * 12000, (part + 1) * 12000).join('') });
  }
  const batches: string[] = []; let batch: unknown[] = [];
  for (const unit of units) {
    releaseAssert(Buffer.byteLength(canonicalReleaseJson([unit])) <= 96 * 1024, 'GENERATION_UNIT_LIMIT');
    if (Buffer.byteLength(canonicalReleaseJson([...batch, unit])) > 96 * 1024) { batches.push(canonicalReleaseJson(batch)); batch = []; }
    batch.push(unit);
  }
  if (batch.length) batches.push(canonicalReleaseJson(batch));
  return batches;
}
export interface GenerationCall { inputDigest: string; output: string | null; diagnostic?: string; rawDigest?: string }
export interface GenerationLedger { plan: GenerationPlan; calls: GenerationCall[] }
export function reserveGenerationCall(ledger: GenerationLedger, input: string): GenerationLedger {
  releaseAssert(ledger.calls.length < ledger.plan.maxCalls && Buffer.byteLength(input) <= 128 * 1024, 'GENERATION_BUDGET');
  const inputDigest = receiptDigest(input);
  releaseAssert(ledger.calls.filter(c => c.inputDigest === inputDigest).length < 2, 'GENERATION_ATTEMPTS');
  return { ...ledger, calls: [...ledger.calls, { inputDigest, output: null }] };
}
