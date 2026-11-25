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

// Keep new resolution lines and removals from the target branch. Removals
// present only on a side branch are already accounted for by its selected commits.
async function mergeResolutionLines(diff: string, head: string, parent: string | null, excluded: ReadonlySet<string>, git: ReadGitText) {
  const output: string[] = [];
  for (const section of diff.split(/(?=^diff --(?:cc|combined) )/m)) {
    const lines = section.split('\n'), added = new Map<number,number>(), removed = new Map<number,number>();
    let oldPath: string | null = null, newPath: string | null = null, prefix = '', next = 0, old = 0;
    let modeChange: string | undefined;
    for (const [index, line] of lines.entries()) {
      const mode = !prefix && /^mode ([0-7]{6}(?:,[0-7]{6})+)\.\.([0-7]{6})$/.exec(line);
      if (mode && !mode[1]!.split(',').includes(mode[2]!)) modeChange = line;
      if (!prefix && line.startsWith('--- ')) oldPath = patchPath(line, 'a/');
      if (!prefix && line.startsWith('+++ ')) newPath = patchPath(line, 'b/');
      const hunk = /^(@{3,}) -(\d+)(?:,\d+)? (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) { prefix = '+'.repeat(hunk[1]!.length - 1); old = Number(hunk[2]); next = Number(hunk[3]); continue; }
      if (!prefix || line.length < prefix.length) continue;
      const columns = line.slice(0,prefix.length);
      if (columns.includes('-')) {
        if (columns[0] === '-') removed.set(index,old++);
        continue;
      }
      if (!/^[ +]+$/.test(columns)) continue;
      if (columns[0] === ' ') old++;
      if (columns === prefix) added.set(index,next);
      next++;
    }
    const hidden = new Set<number>();
    await hideUnattributedLines(removed, oldPath, parent, excluded, git, hidden);
    await hideUnattributedLines(added, newPath, head, excluded, git, hidden);
    const header = /^diff --(?:cc|combined) (.+)$/.exec(lines[0] ?? '');
    const path = newPath ?? oldPath ?? (header && decodeDiffPath(header[1]!));
    if (path && (modeChange || hidden.size < added.size + removed.size)) {
      output.push(path);
      if (modeChange) output.push(modeChange);
      for (const [index, line] of lines.entries()) {
        if (!hidden.has(index) && (added.has(index) || removed.has(index)))
          output.push((added.has(index) ? '+' : '-') + line.slice(prefix.length));
      }
    }
  }
  return output.join('\n');
}

type ReadGitText = (args: string[]) => Promise<string>;

// With core.quotePath=false Git leaves UTF-8 intact and C-quotes special
// characters such as tabs. An unquoted path with spaces can end in a separator tab.
function decodeDiffPath(input: string) {
  let path = input.replace(/\t$/, '');
  if (path.startsWith('"') && path.endsWith('"')) {
    const escapes: Record<string, string> = {a:'\x07',b:'\b',t:'\t',n:'\n',v:'\v',f:'\f',r:'\r','"':'"','\\':'\\'};
    path = path.slice(1, -1).replace(/\\([abtnvfr"\\]|[0-7]{3})/g,
      (_, value: string) => escapes[value] ?? String.fromCharCode(Number.parseInt(value, 8)));
  }
  return path;
}

function patchPath(header: string, prefix: string) {
  const path = decodeDiffPath(header.slice(4));
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

async function hideUnattributedLines(rows: Map<number, number>, path: string | null, revision: string | null,
  excluded: ReadonlySet<string>, git: ReadGitText, hidden: Set<number>) {
  if (!rows.size) return;
  let blame = '';
  if (path && revision) {
    // Native blame follows renames. -C repeated also finds blocks copied from
    // unmodified files. Keep Git's normal similarity thresholds so an independent
    // short example in an unrelated file is not mistaken for a copied block.
    const locations = [...rows.values()];
    const range = locations[0] + ',' + locations.at(-1);
    try { blame = await git(['blame', '--no-textconv', '--incremental', '--root', '-M', '-C', '-C', '-C', '-L', range, revision, '--', path]); }
    catch { /* Omit lines without a verified origin, including gitlinks. */ }
  }
  const spans = [...blame.matchAll(/^([a-f0-9]{40}) \d+ (\d+) (\d+)$/gm)].map(m => ({
    start: Number(m[2]), end: Number(m[2]) + Number(m[3]), keep: !excluded.has(m[1]!),
  })).sort((a, b) => a.start - b.start);
  let which = 0;
  for (const [index, line] of rows) {
    while (spans[which] && spans[which]!.end <= line) which++;
    const span = spans[which];
    if (!span?.keep || span.start > line) hidden.add(index);
  }
}

async function filterPatchLines(patch: string, parent: string | null, head: string, excluded: ReadonlySet<string>, git: ReadGitText) {
  const pieces: string[] = [];
  for (const section of patch.split(/(?=^diff --git )/m)) {
    const lines = section.split('\n');
    const removed = new Map<number, number>(), added = new Map<number, number>();
    let oldLine = 0, newLine = 0, inHunk = false;
    let oldPath: string | null = null, newPath: string | null = null;
    for (const [index, line] of lines.entries()) {
      if (!inHunk && line.startsWith('--- ')) oldPath = patchPath(line, 'a/');
      if (!inHunk && line.startsWith('+++ ')) newPath = patchPath(line, 'b/');
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) { inHunk = true; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
      else if (inHunk && line.startsWith('-')) removed.set(index, oldLine++);
      else if (inHunk && line.startsWith('+')) added.set(index, newLine++);
      else if (inHunk && line.startsWith(' ')) { oldLine++; newLine++; }
    }
    if (!removed.size && !added.size) { pieces.push(section); continue; }
    const hidden = new Set<number>();
    await hideUnattributedLines(removed, oldPath, parent, excluded, git, hidden);
    await hideUnattributedLines(added, newPath, head, excluded, git, hidden);
    if (hidden.size < added.size + removed.size)
      pieces.push(lines.filter((_, index) => !hidden.has(index)).join('\n'));
  }
  return pieces.join('');
}

/** Use the already fetched product history so GitHub's comparison and PR file limits cannot omit changes. */
export async function officialCandidateDiff(directory: string, sourceSha: string, baselineSha: string | null,
  selected?: { exclude: string[]; mixedMerge: boolean; excludedCommits: ReadonlySet<string> }) {
  const gitSha = /^[a-f0-9]{40}$/;
  if (!gitSha.test(sourceSha) || (baselineSha !== null && !gitSha.test(baselineSha))) throw Error('CONTENT_SOURCE_IDENTITY');
  const home = await mkdtemp(join(tmpdir(), 'steward-candidate-diff-'));
  try {
    const baseline = baselineSha ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const diff = selected?.mixedMerge ? ['show', '--format=', '--cc'] : ['diff'];
    const revisions = selected?.mixedMerge ? [sourceSha] : [baseline, sourceSha];
    const readGit: ReadGitText = async args => {
      const child = spawn('git', ['--no-replace-objects','-c','core.hooksPath=',...args], {
        cwd: directory, env: { ...isolatedBuildEnvironment(process.env, home), GIT_NO_LAZY_FETCH: '1' },
        windowsHide: true, stdio: ['ignore','pipe','ignore'],
      });
      const parts: Buffer[] = [];
      const read = async () => { for await (const part of child.stdout) parts.push(part); };
      const [[code]] = await Promise.all([once(child,'close'),read()]);
      if (code !== 0) throw Error('CONTENT_SOURCE_DIFF');
      try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(parts)); }
      catch { throw Error('CONTENT_SOURCE_ENCODING'); }
    };
    const exclusions = selected?.exclude.map(path => ':(top,exclude,literal)' + path) ?? [];
    const options = ['--no-ext-diff',
      '--no-textconv', '--no-color', ...(selected && !selected.mixedMerge ? ['--find-renames','--find-copies','--find-copies-harder'] : ['--no-renames']),
      ...(selected ? ['--src-prefix=a/','--dst-prefix=b/','--unified=0'] : ['--unified=2']),
    ];
    let text: string;
    if (selected?.mixedMerge && (await readGit(['show','-s','--format=%P',sourceSha])).trim().split(' ').length === 2) {
      // Replay the automatic merge to identify manual resolutions, including
      // files whose final tree happens to match one parent. Read only their
      // first-parent delta and attribute its lines to the actual commits.
      const resolved = await readGit(['show','--format=','--remerge-diff','--name-only','--no-renames','-z',
        sourceSha,'--',...exclusions]);
      const patches: string[] = [];
      for (const path of resolved.split('\0').filter(Boolean)) {
        const patch = await readGit(['-c','core.quotePath=false','diff',...options,baseline,sourceSha,'--',':(top,literal)' + path]);
        patches.push(await filterPatchLines(patch.replace(/^(@@ [0-9,+ -]+ @@) [^\n]*/gm, '$1'),
          baselineSha, sourceSha, selected.excludedCommits, readGit));
      }
      text = patches.join('');
    } else {
      text = await readGit([...(selected ? ['-c','core.quotePath=false'] : []), ...diff,...options,...revisions,'--',...exclusions]);
      // Git can append the preceding unchanged line to a hunk header even with --unified=0.
      if (selected?.mixedMerge) text = await mergeResolutionLines(text, sourceSha, baselineSha, selected.excludedCommits, readGit);
      else if (selected) {
        text = text.replace(/^(@{2,} [0-9,+ -]+ @{2,}) [^\n]*/gm, '$1');
        text = await filterPatchLines(text, baselineSha, sourceSha, selected.excludedCommits, readGit);
      }
    }
    if (selected && !text) return [];
    const details = { sourceSha, baselineSha };
    return splitContentText(text).map(chunk => ({ kind: 'source-range-diff', details: { ...details, ...chunk } }));
  } finally { await rm(home, { recursive: true, force: true }); }
}

const officialCandidateConstraints = [
  '按 organizationTemplate 的栏目及注释填写适用内容。只返回符合 outputSchema 的 JSON 对象，顶层仅含 paragraphs。版本标题、栏目排版、贡献者及版本记录由 Steward 生成；审阅提示与 PR 信息属于候选 PR 的外层。',
  '每段的 sourceIds 引用本次 sources 中实际支持该段陈述的 id。qualification 用 SOURCE_CONFIRMED 表示材料直接支持，确有必要向读者说明且尚待核实的内容用 UNVERIFIED。当前候选起草请求没有提供经核验的测试来源，不能使用 TEST_CONFIRMED。上版发行记录仅作背景，本版待构建的制品只能描述为预期。',
  'section 使用 outputSchema 中的栏目键。summary 最多一条，textZh 写成单行概述。summary 与 highlights 可择一使用，也可都省略。其余栏目的 textZh 写成“**短标题**。具体说明”，标题和说明在同一行。requiredActions 的短标题写实际受影响的使用者。',
  '链接使用有依据的公开 HTTPS 地址。同仓源码及工作流引用使用本版标签或对应的固定提交。当前候选阶段尚未核定单件发行附件，省略这些附件的下载直链。',
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
