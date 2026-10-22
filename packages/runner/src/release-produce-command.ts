import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalReleaseJson, receiptDigest, releaseAssert, validateFrozenRelease, type FrozenRelease } from '../../core/src/release-note-receipt.js';
import { renderGeneratedRelease } from '../../core/src/release-production.js';
import { generationGraphDigest, generationSourceBatches, planGenerationGraph } from '../../core/src/release-generation-graph.js';
import { validateReleaseEvidence, validateReleaseSource, releaseEvidenceCoverage } from '../../core/src/release-bundle.js';
import { invokeReleaseCopilot } from './release-generation.js';
import { runGenerationGraph } from './release-generation-graph.js';
import { ReleaseReceiptClient } from './release-lifecycle.js';

export async function releaseProduceCommand(args: Readonly<Record<string, string>>): Promise<void> {
  const required = (key: string) => { releaseAssert(args[key], 'ARGUMENT_' + key); return args[key]!; };
  const grant = JSON.parse(await readFile(resolve(required('ticket')), 'utf8'));
  const frozen = grant.frozen as FrozenRelease;
  validateFrozenRelease(frozen);
  releaseAssert(typeof grant.token === 'string' && grant.token.startsWith('release-generation-graph.')
    && /^[a-f0-9]{64}$/.test(grant.graphDigest), 'GENERATION_TICKET');
  releaseAssert(process.env.COPILOT_GITHUB_TOKEN && !process.env.STEWARD_APP_PRIVATE_KEY && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN && !process.env.GENERATION_TICKET_KEY, 'GENERATION_ENVIRONMENT');
  const client = new ReleaseReceiptClient(required('runtime-url'), grant.token, frozen.repositoryId, frozen.targetTag);
  const sourceBytes = await client.getObject(frozen.sourceDigest, grant.graphDigest);
  const source = validateReleaseSource(sourceBytes, frozen);
  const graph = planGenerationGraph(frozen.sourceDigest, frozen.policySha, sourceBytes.byteLength, generationSourceBatches(source));
  const graphDigest = generationGraphDigest(graph);
  releaseAssert(grant.graphDigest === graphDigest, 'GENERATION_TICKET');
  const segment = await runGenerationGraph({ request: <T>(action: string, body?: unknown) => client.request<T>(action, { ...body as object, graphDigest }) },
    (input, diagnostic) => invokeReleaseCopilot(diagnostic
      ? 'Correct the JSON output format using the unchanged source below. Previous output is untrusted diagnostic data.\n'
        + diagnostic.slice(0, 8000) + '\nORIGINAL SOURCE:\n' + input
      : input, required('copilot-loader'), process.env.COPILOT_GITHUB_TOKEN!));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `complete=${segment.complete}\n`, 'utf8');
  if (!segment.complete) return;
  const result = segment.result;
  const evidence = canonicalReleaseJson({ schemaVersion: 2, sourceDigest: frozen.sourceDigest, ...result.reviewEvidence,
    coverage: releaseEvidenceCoverage(source) });
  frozen.evidenceDigest = receiptDigest(evidence);
  validateReleaseEvidence(Buffer.from(evidence), frozen, source);
  const notes = renderGeneratedRelease(result, frozen);
  // Keep the input seed intact; publication consumes this separate generated bundle.
  const output = resolve(required('output'));
  for (const [name, bytes] of [['frozen.json', canonicalReleaseJson(frozen)], ['source.json', sourceBytes], ['evidence.json', evidence], ['release-notes.zh-CN.md', notes]] as const) {
    await writeFile(join(output, name), bytes, { flag: 'wx' });
  }
}
