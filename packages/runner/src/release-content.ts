import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConditionalNotes } from '../../core/src/conditional-release-notes.js';
import { isolatedBuildEnvironment } from './build-environment.js';
import { RELEASE_WRITING_PROMPT, contentOutputSchema, validateContentResult, buildConditionalDraft, splitContentText, type ContentInput } from '../../core/src/release-content.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

type CandidateInput = {
  unit: ContentInput['units'][number];
  template: string;
  evidence: readonly { kind: string; details: unknown }[];
};

export function officialCandidateInput(options: CandidateInput) {
  const sources = options.evidence.map(source => ({ id: hash(source), ...source }));
  return {
    prompt: RELEASE_WRITING_PROMPT,
    organizationTemplate: options.template,
    constraints: officialCandidateConstraints,
    outputSchema: contentOutputSchema(true),
    units: [options.unit],
    sources,
  };
}

export async function generateOfficialCandidateNotes(options: CandidateInput & { call: (input: string) => Promise<{ text: string }> }) {
  const input = officialCandidateInput(options);
  const sourceIds = [...new Set(input.sources.map(source => source.id))];
  const response = await options.call(JSON.stringify(input));
  const result = validateContentResult('DRAFT', response.text, sourceIds, [], undefined, true);
  if (!('paragraphs' in result)) throw new Error('CONTENT_OUTPUT_SCHEMA');
  return parseConditionalNotes(buildConditionalDraft(result.paragraphs));
}
