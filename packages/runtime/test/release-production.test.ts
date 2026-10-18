import { describe, expect, it } from 'vitest';
import { generationPlan, parseGeneratedRelease, renderGeneratedRelease } from '../../core/src/release-production.js';
import { newReleaseReceipt } from '../../core/src/release-note-receipt.js';
import { rebindReleaseBuild, currentReleaseBuild } from '../../core/src/release-rebuild.js';
import { frozenFixture, notesFixture, sha } from '../../core/test/release-receipt-fixture.js';
import { generateRelease, isolatedCopilotEnvironment, isolatedCopilotArguments } from '../../runner/src/release-generation.js';
import { ReleaseGenerationStore } from '../src/release-generation-store.js';
import { ReleaseReceiptStore } from '../src/release-note-receipts.js';
import { ReleaseTestDb } from './release-test-db.js';

const generated = { userNotes: { upgrade: [], changes: [{ category: '修复', text: '修复导出时丢失文件的问题。' }] }, reviewEvidence: { internalChanges: ['调整导出实现。'], unknowns: [] } };
const output = JSON.stringify(generated);
const plan = generationPlan('a'.repeat(64), sha('c'), ['complete source']);
function client(store: ReleaseGenerationStore) {
  return { request: async <T>(_action?: string, value?: unknown): Promise<T> => {
    const b = value as any;
    return (b.action === 'prepare' ? await store.prepare(9001, 'v1.2.3', b.plan) : await store.mutate(9001, 'v1.2.3', b.version, b.action, b.input, b.index)) as T;
  } };
}
describe('release production protocol and durable budget', () => {
  it('handles long JSON whitespace while retaining strict BOM and non-JSON whitespace rejection', () => {
    expect(parseGeneratedRelease(Buffer.from('\t'.repeat(30000) + output + ' \r\n'))).toEqual(generated);
    expect(() => parseGeneratedRelease(Buffer.from(output + '\t'.repeat(30000) + 'x'))).toThrow();
    for (const prefix of ['\ufeff', '\u00a0', '\v']) expect(() => parseGeneratedRelease(Buffer.from(prefix + output))).toThrow();
  });
  it('accepts the explicit fence and renders only trusted links/contributors', () => {
    const value = parseGeneratedRelease(Buffer.from('```json\n' + output + '\n```'));
    expect(renderGeneratedRelease(value, frozenFixture())).toContain('### 修复');
    for (const invalid of ['\ufeff' + output, output + output, 'preface\n' + output, output.replace('"upgrade":[]', '"upgrade":[],"upgrade":[]'), output.replace('"unknowns":[]', '"unknowns":[],"extra":true')]) expect(() => parseGeneratedRelease(Buffer.from(invalid))).toThrow();
  });
  it('reuses completed output after a fresh store instance without calling the producer', async () => {
    const db = new ReleaseTestDb();
    try {
      await generateRelease(plan, client(new ReleaseGenerationStore(db.binding())), async () => output);
      expect(await generateRelease(plan, client(new ReleaseGenerationStore(db.binding())), async () => { throw new Error('must reuse'); })).toEqual(generated);
    } finally { db.database.close(); }
  });
  it('counts unknown outcomes across reruns and rejects the third call', async () => {
    const db = new ReleaseTestDb(); const store = new ReleaseGenerationStore(db.binding()); let calls = 0;
    try {
      for (let i = 0; i < 3; i++) await expect(generateRelease(plan, client(store), async () => { calls++; throw new Error('lost'); })).rejects.toThrow();
      expect(calls).toBe(2); expect((await store.read(9001, 'v1.2.3'))?.ledger.calls).toHaveLength(2);
      await expect(store.prepare(9001, 'v1.2.3', generationPlan('b'.repeat(64), sha('c'), ['different']))).rejects.toThrow('OCCUPIED');
    } finally { db.database.close(); }
  });
  it('persists invalid output and uses only the one remaining format attempt', async () => {
    const db = new ReleaseTestDb(); const store = new ReleaseGenerationStore(db.binding()); let calls = 0;
    try {
      await generateRelease(plan, client(store), async () => ++calls === 1 ? 'invalid' : output);
      expect(calls).toBe(2); expect((await store.read(9001, 'v1.2.3'))?.ledger.calls[0]?.diagnostic).toBe('invalid');
      const saved = (await store.read(9001, 'v1.2.3'))!;
      expect(Buffer.from(await new ReleaseReceiptStore(db.binding()).readObject(9001, saved.ledger.calls[1]!.rawDigest!)).toString()).toBe(output);
    } finally { db.database.close(); }
  });
  it('rejects racing reservation versions', async () => {
    const db = new ReleaseTestDb(); const store = new ReleaseGenerationStore(db.binding());
    try {
      await store.prepare(9001, 'v1.2.3', plan);
      const results = await Promise.allSettled([store.mutate(9001, 'v1.2.3', 0, 'reserve', 'source'), store.mutate(9001, 'v1.2.3', 0, 'reserve', 'source')]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    } finally { db.database.close(); }
  });
  it('binds generation tickets to repository, tag, policy and expiry', async () => {
    const db = new ReleaseTestDb(); const store = new ReleaseGenerationStore(db.binding());
    try {
      await store.prepare(9001, 'v1.2.3', plan);
      const token = await store.ticket(9001, 'v1.2.3', 1000);
      await store.authorize(9001, 'v1.2.3', token, 2000, sha('c'));
      for (const [repo, tag, time, policy] of [[9002, 'v1.2.3', 2000, sha('c')], [9001, 'v1.2.4', 2000, sha('c')], [9001, 'v1.2.3', 3601000, sha('c')], [9001, 'v1.2.3', 2000, sha('d')]] as const) {
        await expect(store.authorize(repo, tag, token, time, policy)).rejects.toThrow('GENERATION_AUTH');
      }
    } finally { db.database.close(); }
  });
  it('does not pass App, runtime, BYOK, GitHub or user configuration to the model', () => {
    const env = isolatedCopilotEnvironment('/empty', 'personal', { STEWARD_APP_PRIVATE_KEY: 'secret', GITHUB_TOKEN: 'secret', COPILOT_PROVIDER_API_KEY: 'secret', NODE_OPTIONS: '--require evil', HOME: '/old' });
    expect(Object.values(env)).not.toContain('secret'); expect(env.HOME).toBe('/empty'); expect(env.COPILOT_GITHUB_TOKEN).toBe('personal');
    expect(isolatedCopilotArguments).toContain('--available-tools'); expect(isolatedCopilotArguments).not.toContain('--allow-all-tools');
  });
});
describe('expired asset recovery', () => {
  it('preserves approval and frozen identity only for identical manifests and toolchain', () => {
    const frozen = frozenFixture(); frozen.toolchainDigest = 'f'.repeat(64); frozen.build = { runId: 1, artifactId: 2, artifactName: 'assets', headSha: sha('c') };
    const r = newReleaseReceipt(frozen, notesFixture); r.phase = 'merged';
    const next = rebindReleaseBuild(r, { ...frozen.build, runId: 3, artifactId: 4 }, [], frozen.toolchainDigest, 'now');
    expect(next.frozenDigest).toBe(r.frozenDigest); expect(next.approval).toEqual(r.approval); expect(currentReleaseBuild(next)?.artifactId).toBe(4);
    expect(() => rebindReleaseBuild(r, { ...frozen.build!, artifactId: 4 }, [], 'e'.repeat(64), 'now')).toThrow('REBUILD_STATE');
    expect(() => rebindReleaseBuild({ ...r, paused: true }, frozen.build!, [], frozen.toolchainDigest!, 'now')).toThrow();
    expect(() => rebindReleaseBuild(r, frozen.build!, [{} as any], frozen.toolchainDigest!, 'now')).toThrow();
  });
});
