import {describe,it,expect} from 'vitest';
import {evaluatorSha,readEvaluatorAuthorities} from '../src/workflow-evaluator.js';
const policy='a'.repeat(40), evaluator='b'.repeat(40);
const source={version:1,repositories:{}};
const text=JSON.stringify(source);
const file={type:'file',encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};
describe('immutable evaluator authority',()=>{
 it('keeps deployment and evaluator versions separate',()=>{
  const env={POLICY_SHA:policy,APP_ID:'1',INSTALLATION_ID:'1'};
  expect(evaluatorSha(env)).toBe(policy);
  expect(evaluatorSha({...env,WORKFLOW_EVALUATOR_SHA:evaluator})).toBe(evaluator);
  expect(()=>evaluatorSha({...env,WORKFLOW_EVALUATOR_SHA:'main'})).toThrow('CONTRACT_EVALUATOR_SHA');
 });
 it('reads only the configured immutable central source',async()=>{
  expect(await readEvaluatorAuthorities({getContent:async(...args:unknown[])=>{
   expect(args).toEqual(['splrad','steward','config/workflow-contract-authority.json',evaluator]);return file;
  }},evaluator)).toEqual(source);
 });
 it.each([{type:'symlink'},{encoding:'utf8'},{size:65537},{size:0},{size:undefined}])('rejects malformed authority metadata %j',async change=>{
  await expect(readEvaluatorAuthorities({getContent:async()=>({...file,...change})},evaluator)).rejects.toThrow('CONTRACT_EVALUATOR_SOURCE');
 });
 it('does not turn unavailable sources into an empty authority',async()=>{
  await expect(readEvaluatorAuthorities({getContent:async()=>{throw new Error('403');}},evaluator)).rejects.toThrow('403');
 });
});
