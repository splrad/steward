import { generationGraphLimits as limits } from '../../core/src/release-generation-graph.js';
import { canonicalReleaseJson, releaseAssert } from '../../core/src/release-note-receipt.js';
import { parseGeneratedRelease, type GeneratedRelease } from '../../core/src/release-production.js';

export interface GenerationGraphClient {
  request<T>(action: string, body?: unknown): Promise<T>;
}
interface Progress { complete: boolean; ready: string[]; callsRemaining: number; runsRemaining: number }

/** One bounded execution segment. A privileged issuer, not this process, issues the next ticket. */
export async function runGenerationGraph(
  client: GenerationGraphClient,
  invoke: (input: string, diagnostic?: string) => Promise<string>,
  now: () => number = Date.now,
): Promise<{ complete: true; result: GeneratedRelease } | { complete: false }> {
  const deadline = now() + limits.runTimeoutMs;
  let calls = 0;
  while (true) {
    const progress = await client.request<Progress>('generation-graph', { action: 'status' });
    if (progress.complete) {
      const result = await client.request<{ output: string }>('generation-graph', { action: 'result' });
      return { complete: true, result: parseGeneratedRelease(Buffer.from(result.output)) };
    }
    if (progress.callsRemaining === 0 || calls === limits.callsPerRun || now() + limits.callTimeoutMs >= deadline) {
      releaseAssert(progress.runsRemaining > 0, 'GENERATION_RUN_BUDGET');
      await client.request('generation-graph', { action: 'yield' });
      return { complete: false };
    }
    releaseAssert(progress.ready.length > 0, 'GENERATION_NODE_EXHAUSTED');
    const nodeId = progress.ready[0]!;
    const reserved = await client.request<{ reservation: string; input: string; diagnostic?: string | null; outputBytes?: number }>('generation-graph', { action: 'reserve', nodeId });
    calls++;
    // A provider/transport failure leaves the reservation intact. A new ticket
    // may retry once; the same segment must not repeat an unknown submission.
    const output = await invoke(reserved.input, reserved.diagnostic ?? undefined);
    let normalized: string;
    try {
      normalized = canonicalReleaseJson(parseGeneratedRelease(Buffer.from(output)));
      const outputLimit = reserved.outputBytes ?? limits.outputBytes;
      releaseAssert((outputLimit === limits.outputBytes || outputLimit === limits.rootOutputBytes)
        && Buffer.byteLength(normalized) <= outputLimit, 'GENERATION_BATCH_OUTPUT');
    } catch {
      await client.request('generation-graph', { action: 'diagnostic', nodeId, reservation: reserved.reservation,
        output: output.length === 0 ? 'provider returned empty output'
          : Buffer.byteLength(output) <= 64 * 1024 ? output : 'provider output exceeded protocol limit' });
      continue;
    }
    await client.request('generation-graph', { action: 'complete', nodeId, reservation: reserved.reservation, output: normalized });
  }
}
