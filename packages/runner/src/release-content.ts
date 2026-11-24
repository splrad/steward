import { contentOutputSchema } from '../../core/src/release-content.js';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitReleaseInputOptions } from './release-git-input.js';
import { assertDeliveryPath } from '../../core/src/delivery-config.js';
import { parseConditionalNotes } from '../../core/src/conditional-release-notes.js';
import { committedVersionNotes } from '../../core/src/release-template.js';
import { isolatedBuildEnvironment } from './build-environment.js';
import { RELEASE_WRITING_PROMPT, CONTENT_PROMPT, CONDITIONAL_CONTENT_PROMPT, validateContentResult, buildConditionalDraft, splitContentText, releaseAffectedUnitIds, utf8Length,
  type ContentInput, type ContentItem, type ContentStage } from '../../core/src/release-content.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ContentSource {
  id: string; unitId: string; path: string; previousPath: string | null; status: string; oid: string;
  mode: string; byteLength: number; encoding: string; sha256: string; start: number; end: number;
  text: string; stage: 'CONTEXT' | 'DIFF';
  documentationText?: true;
}
export interface ContentPayload { stage: ContentStage; unitIds: string[]; units: ContentInput['units']; sources: ContentSource[]; items: ContentItem[]; background: ContentItem[]; conditional?: true }
export function contentWireInput(payload: ContentPayload) { return JSON.stringify({ prompt: payload.conditional ? CONDITIONAL_CONTENT_PROMPT : CONTENT_PROMPT,
  outputSchema: contentOutputSchema(payload.conditional), constraints: 'Return only the schema object, without Markdown fences or extra keys. Omit optional paragraphs without product facts. For a relevant claim with uncertain verification, set qualification to UNVERIFIED and describe only the specific consequence for the reader; TEST_CONFIRMED is unavailable unless tested source IDs are explicitly supplied.', ...payload }); }

/** Use the already fetched product history so GitHub's comparison and PR file limits cannot omit changes. */
export async function officialCandidateDiff(directory: string, sourceSha: string, baselineSha: string | null) {
  const gitSha = /^[a-f0-9]{40}$/;
  if (!gitSha.test(sourceSha) || (baselineSha !== null && !gitSha.test(baselineSha))) throw Error('CONTENT_SOURCE_IDENTITY');
  const home = await mkdtemp(join(tmpdir(), 'steward-candidate-diff-'));
  try {
    const baseline = baselineSha ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const git = spawn('git', ['--no-replace-objects', '-c', 'core.hooksPath=', 'diff', '--no-ext-diff',
      '--no-textconv', '--no-color', '--no-renames', '--unified=2', baseline, sourceSha, '--'], {
      cwd: directory, env: { ...isolatedBuildEnvironment(process.env, home), GIT_NO_LAZY_FETCH: '1' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const completion = once(git, 'close');
    const parts: Buffer[] = [];
    const read = async () => {
      for await (const part of git.stdout) parts.push(part);
    };
    const [[code]] = await Promise.all([completion, read()]);
    if (code !== 0) throw Error('CONTENT_SOURCE_DIFF');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts)); }
    catch { throw Error('CONTENT_SOURCE_ENCODING'); }
    const details = { sourceSha, baselineSha };
    return splitContentText(text).map(chunk => ({ kind: 'source-range-diff', details: { ...details, ...chunk } }));
  } finally { await rm(home, { recursive: true, force: true }); }
}

const officialCandidateConstraints = [
  '按 organizationTemplate 的栏目及注释填写适用内容。只返回符合 outputSchema 的 JSON 对象，顶层仅含 paragraphs。版本标题、栏目排版、贡献者及版本记录由 Steward 生成；审阅提示与 PR 信息属于候选 PR 的外层。',
  '每段的 sourceIds 引用本次 sources 中实际支持该段陈述的 id。qualification 用 SOURCE_CONFIRMED 表示材料直接支持，确有必要向读者说明且尚待核实的内容用 UNVERIFIED。当前候选起草请求没有提供经核验的测试来源，不能使用 TEST_CONFIRMED。上版发行记录仅作背景，本版待构建的制品只能描述为预期。',
  'section 使用 outputSchema 中的栏目键。summary 最多一条，textZh 写成单行概述。summary 与 highlights 可择一使用，也可都省略。其余栏目的 textZh 写成“**短标题**。具体说明”，标题和说明在同一行。requiredActions 的短标题写实际受影响的使用者。仅 acquisition 可在段落后另附一个围栏代码块，给出本版本的用法。',
  '链接使用有依据的公开 HTTPS 地址。需要提供本版获取入口时，优先采用交付资料中的本版 Release 页面。同仓源码及工作流引用使用本版标签或对应的固定提交。当前候选阶段尚未核定单件发行附件，省略这些附件的下载直链。',
  '每段 textZh 的 UTF-8 长度上限为 2,048 字节，完整 JSON 上限为 12,288 字节。',
].join('\n\n');

/** The official candidate is generated from read-only, source-bound GitHub evidence. */
export async function generateOfficialCandidateNotes(options: {
  unit: ContentInput['units'][number];
  template: string;
  evidence: readonly { kind: string; details: unknown }[];
  call: (input: string) => Promise<{ text: string }>;
}) {
  const sources = options.evidence.map(source => ({ id: hash(source), ...source }));
  const sourceIds = [...new Set(sources.map(source => source.id))];
  const response = await options.call(JSON.stringify({
    prompt: RELEASE_WRITING_PROMPT,
    organizationTemplate: options.template,
    constraints: officialCandidateConstraints,
    outputSchema: contentOutputSchema(true),
    units: [options.unit],
    sources,
  }));
  const result = validateContentResult('DRAFT', response.text, sourceIds, [], undefined, true);
  if (!('paragraphs' in result)) throw new Error('CONTENT_OUTPUT_SCHEMA');
  return parseConditionalNotes(buildConditionalDraft(result.paragraphs));
}

/** Read curated release changes and product context, not a model-coverage copy of every source blob. */
export async function collectContentInput(options: { directory: string; candidateId: string; configDigest: string; units: (GitReleaseInputOptions & { changelogPath?: string })[];
  allUnits?: { id: string; path: string }[]; dependencies?: Record<string, string[]>;
  repository?: string; preparedChanges?: { path: string; content: string | null }[]; sourcePaths?: string[]; conditional?: boolean }) {
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
      const entries: {path:string; text:string; stage:'CONTEXT'|'DIFF'; documentationText?: true}[] = (options.preparedChanges ?? []).filter(f => f.path === changelogPath)
          .map(f => ({ path: f.path, text: f.content ? committedVersionNotes(f.content, unit.unit.version, options.repository ?? (() => { throw new Error('CONTENT_REPOSITORY_REQUIRED'); })(), unit.identity.targetSha, unit.unit.tag).changelog : '', stage: 'DIFF' as const }));
      for (const path of [...new Set([...(unit.contextPaths ?? []), ...(options.sourcePaths ?? [])])]) {
        if (path.startsWith('/') || path.split(/[\\/]/).includes('..') || /[\0\r\n]/.test(path)) throw new Error('CONTENT_SOURCE_PATH');
        entries.push({ path, text: git('show', `${unit.identity.targetSha}:${path}`), stage: 'CONTEXT' });
      }
      if (options.conditional) {
        const rootPath = unit.unit.path === '.' ? '.' : unit.unit.path;
        const baseline = unit.boundary.kind === 'full-tree' ? null : unit.boundary.sha;
        const listing = baseline ? ['diff', '--no-renames', '--name-only', baseline, unit.identity.targetSha] : ['ls-tree', '-r', '--name-only', unit.identity.targetSha];
        const scope = options.allUnits ? '.' : rootPath;
        const paths = git(...listing, '-z', '--', scope).split('\0').filter(path =>
          path !== changelogPath && /\.(?:md|mdx|rst|adoc)$/i.test(path) && !path.split('/').some(part => part.startsWith('.'))
          && !/(?:^|\/)(?:AGENTS|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|CHANGELOG)\.[^.]+$/i.test(path)
          && (!options.allUnits || releaseAffectedUnitIds(path, options.allUnits, options.dependencies ?? {}).includes(unit.unit.id)));
        for (const path of paths) {
          const source = baseline
            ? git('diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--unified=2', baseline, unit.identity.targetSha, '--', `:(literal)${path}`)
            : git('show', `${unit.identity.targetSha}:${path}`);
          if (!source.trim() || baseline && (!/^@@ /m.test(source)
            || /^(?:(?:new|deleted) file mode|(?:old|new) mode|index .+) (?:120000|160000)$/m.test(source))) continue;
          if (!baseline && !/^100(?:644|755) blob /.test(git('ls-tree', unit.identity.targetSha, '--', `:(literal)${path}`))) continue;
          const existing = entries.find(entry => entry.path === path && entry.text === source);
          if (existing) existing.documentationText = true;
          else entries.push({ path, text: source, stage: baseline ? 'DIFF' : 'CONTEXT', documentationText: true });
        }
      }
      for (const entry of entries) {
        const bytes = utf8Length(entry.text), digest = hash(entry.text);
        const chunks = entry.documentationText ? splitContentText(entry.text) : [{ start: 0, end: bytes, text: entry.text }];
        for (const chunk of chunks) {
          const identity = [unit.unit.id, entry.path, digest, ...(chunks.length > 1 ? [chunk.start] : [])];
          sources.push({ id: hash(identity), unitId: unit.unit.id, path: entry.path, previousPath: null,
            status: 'CURATED', oid: unit.identity.targetSha, mode: '100644', byteLength: bytes, encoding: 'utf8', sha256: digest,
            ...chunk, stage: entry.stage, ...(entry.documentationText ? { documentationText: true } : {}) });
        }
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
