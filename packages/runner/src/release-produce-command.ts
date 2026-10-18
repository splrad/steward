import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalReleaseJson, receiptDigest, releaseAssert, type FrozenRelease } from '../../core/src/release-note-receipt.js';
import { generationInputs, generationPlan, renderGeneratedRelease } from '../../core/src/release-production.js';
import { validateReleaseEvidence, validateReleaseSource } from '../../core/src/release-bundle.js';
import { generateRelease, invokeReleaseCopilot } from './release-generation.js';
import { ReleaseReceiptClient } from './release-lifecycle.js';

export async function releaseProduceCommand(args: Readonly<Record<string, string>>): Promise<void> {
  const required = (key: string) => { releaseAssert(args[key], 'ARGUMENT_' + key); return args[key]!; };
  const directory = resolve(required('bundle'));
  const frozen = JSON.parse(await readFile(join(directory, 'frozen.json'), 'utf8')) as FrozenRelease;
  const source = validateReleaseSource(await readFile(join(directory, 'source.json')), frozen);
  const plan = generationPlan(frozen.sourceDigest, frozen.policySha, generationInputs(source));
  const grant = JSON.parse(await readFile(resolve(required('ticket')), 'utf8'));
  releaseAssert(typeof grant.token === 'string' && grant.token.startsWith('release-generation.'), 'GENERATION_TICKET');
  releaseAssert(process.env.COPILOT_GITHUB_TOKEN && !process.env.STEWARD_APP_PRIVATE_KEY && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN, 'GENERATION_ENVIRONMENT');
  const client = new ReleaseReceiptClient(required('runtime-url'), grant.token, frozen.repositoryId, frozen.targetTag);
  const result = await generateRelease(plan, client, input => invokeReleaseCopilot(input, required('copilot-loader'), process.env.COPILOT_GITHUB_TOKEN!));
  const evidence = canonicalReleaseJson({ schemaVersion: 1, sourceDigest: frozen.sourceDigest, ...result.reviewEvidence,
    coverage: { commitShas: source.commits.map((c: any) => c.sha), paths: source.changes.map((c: any) => c.path) } });
  frozen.evidenceDigest = receiptDigest(evidence);
  validateReleaseEvidence(Buffer.from(evidence), frozen, source);
  const notes = renderGeneratedRelease(result, frozen);
  // Keep the input seed intact; publication consumes this separate generated bundle.
  const output = resolve(required('output'));
  for (const [name, bytes] of [['frozen.json', canonicalReleaseJson(frozen)], ['source.json', await readFile(join(directory, 'source.json'))], ['evidence.json', evidence], ['release-notes.zh-CN.md', notes]] as const) {
    await writeFile(join(output, name), bytes, { flag: 'wx' });
  }
}
