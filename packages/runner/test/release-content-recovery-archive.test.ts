import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const {selectContentArchive}=await import(pathToFileURL(resolve('scripts/release-content-recovery.mjs')).href);
const {acceptanceErrorCode}=await import(pathToFileURL(resolve('scripts/business-flow-acceptance.mjs')).href);
import { verifyContentAttemptReceipts } from '../../core/src/release-content.js';

it('bounds public failure diagnostics to machine codes',()=>{
  expect(acceptanceErrorCode(Error('ACCEPTANCE_SOURCE_CHANGED'))).toBe('ACCEPTANCE_SOURCE_CHANGED');
  expect(acceptanceErrorCode(Error('CONTENT_RECOVERY_BINDING'))).toBe('BUSINESS_ACCEPTANCE_STOPPED');
  expect(acceptanceErrorCode(Error('secret text'))).toBe('BUSINESS_ACCEPTANCE_STOPPED');
  expect(acceptanceErrorCode(Error('ACCEPTANCE_SOURCE_CHANGED\nprivate'))).toBe('BUSINESS_ACCEPTANCE_STOPPED');
});

it('reads the original address for a previously transferred receipt',async()=>{
  const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const generated=digest('archive'),controller='a'.repeat(40),candidate='historical';
  const transferred=digest(['content-archive-transfer/v1',generated,controller]);
  const saved={input:{candidateId:candidate,controllerSha:controller,batches:[{attempts:[{recovery:{archiveContentDigest:generated}}]}]}};
  const read=async(path:string)=>{expect(path).toBe(`content/${candidate}/${transferred}/manifest.json`);return saved;};
  const result=await selectContentArchive({id:candidate,contentGenerationDigest:transferred},generated,{loadDocument:read,controllerSha:controller});
  expect(result).toEqual({digest:transferred,transferBaseDigest:generated});
});

it('rejects an archived recovery receipt with an incomplete locator',async()=>{
  const sha='a'.repeat(64);
  const attempt={ordinal:1,startedAt:'2026-11-08T00:00:00Z',status:'REJECTED' as const,model:'fixture',usage:null,errorCode:'CONTENT_OUTPUT_SCHEMA'};
  const recovery={previousAttemptSha256:sha,authorizationId:sha,outputContractSha256:sha,archiveContentDigest:sha};
  await expect(verifyContentAttemptReceipts([attempt,{...attempt,ordinal:2,recovery}])).rejects.toThrow('CONTENT_ATTEMPT_SCHEMA');
});
