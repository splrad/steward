import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectContentInput, contentWireInput, generateOfficialCandidateNotes } from '../src/release-content.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';
import { registerOfflineFixtureRoot } from './offline-fixtures.js';
import { type ContentInput, splitContentText, validateContentResult, verifyContentAttemptReceipts } from '../../core/src/release-content.js';
import { decodeCandidateDocument } from '../../core/src/release-candidate-record.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

const input = (): ContentInput => ({ schemaVersion: 1, repositoryId: 1, candidateId: digest('candidate'), baseSha: 'a'.repeat(40), controllerSha: 'b'.repeat(40),
  configDigest: digest('config'), sourceManifestDigest: digest('manifest'), units: [{ id: 'app', path: '.', version: '1.1.0', tag: 'v1.1.0' }],
  boundaries: [{ unitId: 'app', kind: 'full-tree', sha: null, reference: null }], batches: [] });

it('retains reviewed document additions, removals and material edits beyond the first twelve files and chunks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'release-doc-input-'));
  registerOfflineFixtureRoot(workspace);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', env: isolatedBuildEnvironment(process.env, workspace) }).trim();
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    for (const path of ['units/app/docs', 'units/other/docs']) await mkdir(join(workspace, path), { recursive: true });
    const files = Array.from({ length: 13 }, (_, index) => `units/app/docs/${String(index + 1).padStart(2, '0')}.md`);
    const removed = 'units/app/docs/old.md', added = 'units/app/docs/start.adoc', unrelated = 'units/other/docs/manual.md';
    for (const path of [...files, removed, unrelated]) await writeFile(join(workspace, path), '旧内容。\n');
    git('add', '--all'); git('commit', '-m', 'docs: publish previous documentation');
    const baseline = git('rev-parse', 'HEAD');
    for (const path of files.slice(0, 12)) await writeFile(join(workspace, path), '旧内容。 \n');
    await writeFile(join(workspace, files[12]!), '校订内容。\n'.repeat(1300) + '操作人员现在须先关闭设备。\n');
    await unlink(join(workspace, removed)); await writeFile(join(workspace, added), '交付本版启用指南。\n');
    await writeFile(join(workspace, unrelated), '其他产品的内容。\n');
    git('add', '--all'); git('commit', '-m', 'docs: revise manual');
    const unit = { ...input().units[0]!, path: 'units/app' };
    const collected = await collectContentInput({ directory: workspace, candidateId: input().candidateId, configDigest: input().configDigest,
      repository: 'example/product', conditional: true, allUnits: [unit, { id: 'other', path: 'units/other' }],
      units: [{ workspace, unit, boundary: { kind: 'tag', sha: baseline, reference: 'v1.0.0', version: '1.0.0' },
        identity: { repositoryId: 1, defaultBranch: 'main', targetSha: git('rev-parse', 'HEAD'), controllerSha: input().controllerSha } }],
    });
    expect(collected.sources.filter(source => source.documentationText).map(source => source.path)).toEqual(expect.arrayContaining([...files, removed, added]));
    expect(collected.sources.some(source => source.path === unrelated)).toBe(false);
    expect(collected.sources.find(source => source.path === removed)?.text).toContain('-旧内容。');
    expect(collected.sources.find(source => source.path === added)?.text).toContain('+交付本版启用指南。');
    const material = collected.sources.find(source => source.path === files[12] && source.text.includes('先关闭设备'))!;
    expect(material.start).toBeGreaterThan(0);
    const evidence = collected.sources.map(details => ({kind: 'documentation', details}));
    const notes = await generateOfficialCandidateNotes({unit, template: '## 文档更新', evidence, call: async text => {
      const request = JSON.parse(text);
      const selected = request.sources.find((s: {details: {id: string}}) => s.details.id === material.id);
      expect(selected).toBeDefined();
      return {text: JSON.stringify({paragraphs: [{sourceIds:[selected.id],section:'documentation',
        textZh:'**操作手册**。操作人员需先关闭设备。',qualification:'SOURCE_CONFIRMED'}]})};
    }});
    expect(JSON.stringify(notes)).toContain('操作人员需先关闭设备。');
  } finally { await rm(workspace, { recursive: true, force: true }); }
}, 30_000);

it('requires Chinese closed output, known references and evidence for test claims without exhaustive source coverage', () => {
  const paragraph = {sourceIds:[digest('first')],section:'changes',textZh:'修复实际问题。',qualification:'SOURCE_CONFIRMED'};
  expect(validateContentResult('DRAFT',JSON.stringify({paragraphs:[paragraph]}),[digest('first'),digest('second')])).toBeDefined();
  const command={...paragraph,textZh:'npm install @splrad/product'};
  expect(validateContentResult('DRAFT',JSON.stringify({paragraphs:[paragraph,command]}),[digest('first')])).toBeDefined();
  expect(()=>validateContentResult('DRAFT',JSON.stringify({paragraphs:[command]}),[digest('first')])).toThrow('CONTENT_STATEMENT_INVALID');
  expect(()=>validateContentResult('DRAFT',JSON.stringify({paragraphs:[paragraph],command:'execute'}),[digest('first')])).toThrow('CONTENT_OUTPUT_SCHEMA');
  expect(()=>validateContentResult('DRAFT',JSON.stringify({paragraphs:[{...paragraph,qualification:'TEST_CONFIRMED'}]}),[digest('first')])).toThrow('CONTENT_TEST_EVIDENCE_REQUIRED');
  expect(()=>validateContentResult('DRAFT',JSON.stringify({paragraphs:[paragraph]}),[digest('second')])).toThrow('CONTENT_SOURCE_UNKNOWN');
});

it('retains archive byte splitting without requiring model byte coverage',()=>{
  const text='中文🙂\n'.repeat(1000),parts=splitContentText(text,101);
  expect(parts.map(p=>p.text).join('')).toBe(text);
  expect(parts[0]!.start).toBe(0);expect(parts.at(-1)!.end).toBe(Buffer.byteLength(text));
  expect(parts.every((p,i)=>i===0||p.start===parts[i-1]!.end)).toBe(true);
});

it('archive compatibility keeps old bounded histories but rejects expanded histories containing unknown requests', async () => {
  const attempt = (ordinal: number, status: string, errorCode: string | null) => ({ ordinal, startedAt: '2026-11-07T00:00:00Z', status, errorCode, model: 'unknown', usage: null });
  const decode = (attempts: object[]) => {
    const content = JSON.stringify({ inputDigest: digest('input'), configDigest: digest('config'), attempts, result: null });
    return decodeCandidateDocument([{ schemaVersion: 1, repositoryId: 1, candidateId: digest('candidate'), documentKind: 'cache-entry',
      documentDigest: digest(content), index: 0, count: 1, content }]);
  };
  await expect(decode([1, 2, 3].map(i => attempt(i, 'UNKNOWN', 'RESPONSE_UNKNOWN')))).resolves.toBeDefined();
  await expect(decode([1, 2, 3, 4].map(i => attempt(i, 'UNKNOWN', 'RESPONSE_UNKNOWN')))).rejects.toThrow('CONTENT_CACHE_INVALID');
  await expect(decode([1, 2, 3, 4].map(i => attempt(i, 'REJECTED', 'CONTENT_OUTPUT_SCHEMA')))).rejects.toThrow('CONTENT_CACHE_INVALID');
});

it('rejects mismatched archived contract digests and oversized UTF-8 diagnostics',async()=>{
  const old={ordinal:1,startedAt:'2026-11-08T00:00:00Z',status:'REJECTED' as const,model:'fixture',usage:null,errorCode:'CONTENT_OUTPUT_SCHEMA'};
  const recovery={previousAttemptSha256:digest(JSON.stringify(old)),authorizationId:digest('approval'),outputContractSha256:digest('wrong contract')};
  await expect(verifyContentAttemptReceipts([old,{...old,ordinal:2,recovery}])).rejects.toThrow('CONTENT_RECOVERY_HISTORY');
  const responseText='中'.repeat(12288),diagnostic={responseText,responseSha256:digest(responseText),responseBytes:Buffer.byteLength(responseText),validationErrors:[]};
  await expect(verifyContentAttemptReceipts([{...old,diagnostic}])).rejects.toThrow('CONTENT_ATTEMPT_SCHEMA');
});

it('preserves the adopted prompts and output contracts for existing input callers', () => {
  const unit=input().units[0]!;
  const payload={stage:'DRAFT' as const,unitIds:[unit.id],units:[unit],sources:[],items:[],background:[]};
  for (const conditional of [false,true]) {
    const request=JSON.parse(contentWireInput(conditional?{...payload,conditional:true}:payload));
    expect(request.prompt).toContain('以中文为主体语言');
    expect(request.prompt).toContain(conditional?'按组织模板填写适用栏目':'units 中的 version 和 tag 标识本次发行');
    expect(request.outputSchema).toBeDefined();
  }
});
