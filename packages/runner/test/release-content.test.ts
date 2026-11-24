import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { splitContentText, validateContentResult, verifyContentAttemptReceipts } from '../../core/src/release-content.js';
import { decodeCandidateDocument } from '../../core/src/release-candidate-record.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

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
