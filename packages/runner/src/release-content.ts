import { retryableContentRejection } from '../../core/src/release-content.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitReleaseInputOptions } from './release-git-input.js';
import { assertDeliveryPath } from '../../core/src/delivery-config.js';
import { committedVersionNotes } from '../../core/src/release-template.js';
import { isolatedBuildEnvironment } from './build-environment.js';
import { CONTENT_PROMPT, validateContentResult, validateContentInput, renderUnitContent, utf8Length,
  type ContentInput, type ContentBatch, type ContentItem, type ContentParagraph, type ContentAttempt, type ContentStage } from '../../core/src/release-content.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ContentSource {
  id: string; unitId: string; path: string; previousPath: string | null; status: string; oid: string;
  mode: string; byteLength: number; encoding: string; sha256: string; start: number; end: number;
  text: string; stage: 'CONTEXT' | 'DIFF';
}
export interface ContentPayload { stage: ContentStage; unitIds: string[]; units: ContentInput['units']; sources: ContentSource[]; items: ContentItem[]; background: ContentItem[] }
export interface ContentWork { input: ContentInput; payloads: Record<string, ContentPayload>; results: Record<string, { items: ContentItem[] } | { paragraphs: ContentParagraph[] }>; evidence: { manifests: unknown[]; gaps: unknown[] } }
export interface ContentCacheEntry { inputDigest: string; configDigest: string; attempts: ContentAttempt[]; result: { items: ContentItem[] } | { paragraphs: ContentParagraph[] } | null; split?: boolean }
export type ContentCache = Record<string, ContentCacheEntry>;
export function contentWireInput(payload: ContentPayload) { return JSON.stringify({ prompt: CONTENT_PROMPT, ...payload }); }

/** Read curated release changes and product context, not a model-coverage copy of every source blob. */
export async function collectContentInput(options: { directory: string; candidateId: string; configDigest: string; units: (GitReleaseInputOptions & { changelogPath?: string })[];
  allUnits?: { id: string; path: string }[]; dependencies?: Record<string, string[]>;
  repository?: string; preparedChanges?: { path: string; content: string | null }[]; sourcePaths?: string[] }) {
  if (!options.units.length) throw new Error('CONTENT_UNITS_REQUIRED');
  const first = options.units[0]!;
  if (options.units.some(u => JSON.stringify(u.identity) !== JSON.stringify(first.identity))) throw new Error('CONTENT_IDENTITY_MISMATCH');
  const sources: ContentSource[] = [], manifests = [];
  const home = await mkdtemp(join(tmpdir(), 'steward-content-input-'));
  try {
    for (const unit of options.units) {
      const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=', ...args], {
        cwd: unit.workspace, env: { ...isolatedBuildEnvironment(process.env, home), GIT_NO_LAZY_FETCH: '1' },
        windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const range = unit.boundary.kind === 'full-tree' ? unit.identity.targetSha : `${unit.boundary.sha}..${unit.identity.targetSha}`;
      const commits = git('log', '--format=%H', range).trim().split('\n').filter(Boolean).map(sha => ({ sha }));
      const changelog = unit.changelogPath ?? 'CHANGELOG.md'; assertDeliveryPath(changelog);
      const changelogPath = (unit.unit.path === '.' ? '' : unit.unit.path + '/') + changelog;
      const entries: {path:string; text:string; stage:'CONTEXT'|'DIFF'}[] = (options.preparedChanges ?? []).filter(f => f.path === changelogPath)
          .map(f => ({ path: f.path, text: f.content ? committedVersionNotes(f.content, unit.unit.version, options.repository ?? (() => { throw new Error('CONTENT_REPOSITORY_REQUIRED'); })(), unit.identity.targetSha, unit.unit.tag).changelog : '', stage: 'DIFF' as const }));
      for (const path of [...new Set([...(unit.contextPaths ?? []), ...(options.sourcePaths ?? [])])]) {
        if (path.startsWith('/') || path.split(/[\\/]/).includes('..') || /[\0\r\n]/.test(path)) throw new Error('CONTENT_SOURCE_PATH');
        entries.push({ path, text: git('show', `${unit.identity.targetSha}:${path}`), stage: 'CONTEXT' });
      }
      for (const entry of entries) {
        const bytes = utf8Length(entry.text), digest = hash(entry.text);
        sources.push({ id: hash([unit.unit.id, entry.path, digest]), unitId: unit.unit.id, path: entry.path, previousPath: null,
          status: 'CURATED', oid: unit.identity.targetSha, mode: '100644', byteLength: bytes, encoding: 'utf8', sha256: digest,
          start: 0, end: bytes, text: entry.text, stage: entry.stage });
      }
      manifests.push({ unit: unit.unit, identity: unit.identity, boundary: unit.boundary, commits });
    }
  } finally { await rm(home, { recursive: true, force: true }); }
  const input: ContentInput = { schemaVersion: 2, repositoryId: first.identity.repositoryId, candidateId: options.candidateId,
    baseSha: first.identity.targetSha, controllerSha: first.identity.controllerSha, units: options.units.map(u => u.unit),
    boundaries: options.units.map(u => ({ unitId: u.unit.id, kind: u.boundary.kind, sha: u.boundary.kind === 'full-tree' ? null : u.boundary.sha,
      reference: u.boundary.kind === 'full-tree' ? null : u.boundary.reference })), sourceManifestDigest: hash(manifests), configDigest: options.configDigest, batches: [] };
  return { input, sources, gaps: [], manifests };
}
/** One direct draft per unit; no fixed stages, recursive splitting, or per-source coverage obligation. */
export async function planContentBatches(input: ContentInput, sources: ContentSource[], evidence: ContentWork['evidence'] = { manifests: [], gaps: [] }): Promise<ContentWork> {
  const work: ContentWork = { input: { ...structuredClone(input), schemaVersion: 2, batches: [] }, payloads: {}, results: {}, evidence };
  for (const unit of input.units) {
    const payload: ContentPayload = { stage: 'DRAFT', unitIds: [unit.id], units: [unit], sources: sources.filter(s => s.unitId === unit.id), items: [], background: [] };
    const inputDigest = hash(payload), id = hash([input.candidateId, input.configDigest, inputDigest]);
    const batch: ContentBatch = { id, stage: 'DRAFT', unitIds: [unit.id], sourceIds: payload.sources.map(s => s.id), inputDigest,
      status: 'PENDING', attempts: [], nextCheckAt: null, resultPath: null, errorCode: null };
    work.input.batches.push(batch); work.payloads[id] = payload;
  }
  validateContentInput(work.input); return work;
}
export interface ContentRuntime {
  now(): string;
  editing(): Promise<boolean>;
  preflight(): Promise<'READY' | 'WAIT_AUTH' | 'WAIT_QUOTA'>;
  call(input: string): Promise<{ text: string; model: string; usage: object | null }>;
  save(work: ContentWork, cache: ContentCache): Promise<void>;
}
/** Persist a request before sending; unknown results need native maintenance, not an automatic replay loop. */
export async function resumeContentBatches(work: ContentWork, cache: ContentCache, runtime: ContentRuntime) {
  if (work.input.schemaVersion !== 2) throw new Error('CONTENT_LEGACY_READ_ONLY');
  let calls = 0;
  for (const batch of work.input.batches) {
    if (batch.status === 'READY') continue;
    if (await runtime.editing()) return { status: 'EDITING', calls };
    const key = hash([batch.inputDigest, work.input.configDigest]);
    const entry = cache[key] ??= { inputDigest: batch.inputDigest, configDigest: work.input.configDigest, attempts: [], result: null };
    if (entry.result) {
      work.results[batch.id] = validateContentResult('DRAFT', JSON.stringify(entry.result), batch.sourceIds);
      batch.status = 'READY'; batch.resultPath = `results/${batch.id}.json`; await runtime.save(work, cache); continue;
    }
    if (entry.attempts.some(a => !retryableContentRejection(a)) || batch.attempts.some(a => !retryableContentRejection(a))) {
      batch.status = 'FAILED'; batch.errorCode = entry.attempts.at(-1)?.errorCode ?? 'RESPONSE_UNKNOWN';
      await runtime.save(work, cache); return { status: 'FAILED', calls };
    }
    if (batch.nextCheckAt && Date.parse(batch.nextCheckAt) > Date.parse(runtime.now())) return { status: batch.status, calls };
    const preflight = await runtime.preflight();
    if (preflight !== 'READY') { batch.status = preflight; await runtime.save(work, cache); return { status: preflight, calls }; }
    if (await runtime.editing()) return { status: 'EDITING', calls };
    const attempt: ContentAttempt = { ordinal: Math.max(entry.attempts.length, batch.attempts.length) + 1, startedAt: runtime.now(), status: 'SENT', model: 'server-selected', usage: null, errorCode: null };
    batch.attempts = [...(entry.attempts.length >= batch.attempts.length ? entry.attempts : batch.attempts), attempt]; entry.attempts = batch.attempts; batch.nextCheckAt = null; batch.status = 'RUNNING'; await runtime.save(work, cache); calls++;
    try {
      const response = await runtime.call(contentWireInput(work.payloads[batch.id]!));
      attempt.status = 'RETURNED'; attempt.model = response.model; attempt.usage = response.usage;
      const result = validateContentResult('DRAFT', response.text, batch.sourceIds);
      work.results[batch.id] = result; entry.result = result; batch.resultPath = `results/${batch.id}.json`; batch.status = 'READY'; batch.errorCode = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = /^(?:CONTENT_[A-Z_]+|WAIT_AUTH|WAIT_QUOTA|RESPONSE_UNKNOWN)$/.test(message) ? message : 'RESPONSE_UNKNOWN';
      attempt.status = code === 'RESPONSE_UNKNOWN' ? 'UNKNOWN' : 'REJECTED'; attempt.errorCode = code;
      batch.status = code === 'WAIT_AUTH' || code === 'WAIT_QUOTA' ? code : 'FAILED'; batch.errorCode = code;
      if (batch.status !== 'FAILED') {
        const delay = (error as { retryAfterMs?: number }).retryAfterMs;
        batch.nextCheckAt = new Date(Date.parse(runtime.now()) + (typeof delay === 'number' && Number.isFinite(delay) ? Math.max(60_000, delay) : 60_000)).toISOString();
      }
    }
    await runtime.save(work, cache);
    if (batch.status !== 'READY') return { status: batch.status, calls };
  }
  return { status: 'READY', calls };
}
export function assembleUnitNotes(work: ContentWork) {
  if (!work.input.batches.every(b => b.status === 'READY')) throw new Error('CONTENT_NOT_READY');
  return work.input.units.map(unit => ({ path: `.release-notes/${unit.id}.md`, mode: '100644' as const,
    content: renderUnitContent(work.input.batches.filter(b => b.unitIds.includes(unit.id)).flatMap(b => (work.results[b.id] as { paragraphs: ContentParagraph[] }).paragraphs)) }));
}
