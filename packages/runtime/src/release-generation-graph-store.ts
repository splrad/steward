import { randomBytes } from 'node:crypto';
import { generationGraphDigest, generationGraphLimits as limits, planGenerationGraph, type GenerationGraph } from '../../core/src/release-generation-graph.js';
import { canonicalReleaseJson, receiptDigest, releaseAssert } from '../../core/src/release-note-receipt.js';
import { parseGeneratedRelease } from '../../core/src/release-production.js';
import { ReleaseReceiptStore } from './release-note-receipts.js';

export interface GraphIdentity { repositoryId: number; tag: string; graphDigest: string }
interface GraphRow {
  policy_sha: string; source_digest: string; root_node: string; node_count: number; max_runs: number;
  ready: number; runs: number; run_calls: number; version: number; ticket_digest: string | null; ticket_until: number;
}
interface NodeRow {
  node_id: string; input_digest: string | null; children_json: string; attempts: number;
  reservation: string | null; reserved_ticket: string | null; output_digest: string | null; diagnostic_digest: string | null;
}
export interface GraphLease extends GraphIdentity { token: string; policySha: string; now: () => number }

/** Rows hold progress only. Immutable input/output objects use the existing repository-scoped store. */
export class ReleaseGenerationGraphStore {
  private readonly objects: ReleaseReceiptStore;
  constructor(private readonly db: D1Database) { this.objects = new ReleaseReceiptStore(db); }
  private values(i: GraphIdentity) { return [i.repositoryId, i.tag, i.graphDigest] as const; }
  private graph(i: GraphIdentity) {
    return this.db.prepare('SELECT * FROM release_generation_graphs WHERE repository_id=? AND target_tag=? AND graph_digest=?')
      .bind(...this.values(i)).first<GraphRow>();
  }
  private node(i: GraphIdentity, id: string) {
    return this.db.prepare('SELECT * FROM release_generation_nodes WHERE repository_id=? AND target_tag=? AND graph_digest=? AND node_id=?')
      .bind(...this.values(i), id).first<NodeRow>();
  }
  private async object(repositoryId: number, bytes: string): Promise<string> {
    const buffer = Buffer.from(bytes), digest = receiptDigest(buffer), size = 48 * 1024, total = Math.ceil(buffer.length / size);
    for (let part = 0; part < total; part++) await this.objects.putChunk(repositoryId, digest, part, total, buffer.subarray(part * size, (part + 1) * size).toString('base64'));
    return digest;
  }
  /** Only the issuer may register a plan derived from independently verified source. */
  async saveVerifiedPlan(repositoryId: number, tag: string, graph: GenerationGraph): Promise<void> {
    const bytes = canonicalReleaseJson(graph);
    releaseAssert(Buffer.byteLength(bytes) <= 1024 * 1024, 'GENERATION_PLAN_LIMIT');
    const digest = await this.object(repositoryId, bytes);
    await this.db.prepare('INSERT OR IGNORE INTO release_generation_plans(repository_id,target_tag,source_digest,policy_sha,graph_digest) VALUES(?,?,?,?,?)')
      .bind(repositoryId, tag, graph.sourceDigest, graph.policySha, digest).run();
    const stored = await this.verifiedPlan(repositoryId, tag, graph.sourceDigest, graph.policySha);
    releaseAssert(stored && generationGraphDigest(stored) === digest, 'GENERATION_PLAN_BINDING');
  }
  async verifiedPlan(repositoryId: number, tag: string, sourceDigest: string, policySha: string): Promise<GenerationGraph | null> {
    const row = await this.db.prepare('SELECT graph_digest FROM release_generation_plans WHERE repository_id=? AND target_tag=? AND source_digest=? AND policy_sha=?')
      .bind(repositoryId, tag, sourceDigest, policySha).first<{graph_digest: string}>();
    if (!row) return null;
    const bytes = await this.objects.readObject(repositoryId, row.graph_digest);
    releaseAssert(bytes.byteLength <= 1024 * 1024, 'GENERATION_PLAN_LIMIT');
    const graph = JSON.parse(Buffer.from(bytes).toString('utf8')) as GenerationGraph;
    releaseAssert(graph.sourceDigest === sourceDigest && graph.policySha === policySha
      && generationGraphDigest(graph) === row.graph_digest, 'GENERATION_PLAN_BINDING');
    return graph;
  }
  async prepare(repositoryId: number, tag: string, sourceBytes: number, graph: GenerationGraph, inputs: string[], offset = 0): Promise<GraphIdentity & { nextOffset: number; ready: boolean }> {
    releaseAssert(Number.isSafeInteger(repositoryId) && repositoryId > 0 && /^v\d+\.\d+\.\d+$/.test(tag), 'GENERATION_IDENTITY');
    const expected = planGenerationGraph(graph.sourceDigest, graph.policySha, sourceBytes, inputs);
    releaseAssert(canonicalReleaseJson(expected) === canonicalReleaseJson(graph), 'GENERATION_GRAPH');
    return this.prepareVerifiedPage(repositoryId, tag, graph, inputs, offset);
  }
  /** Internal issuer supplies a graph derived from verified source, with only this page's text retained. */
  async prepareVerifiedPage(repositoryId: number, tag: string, graph: GenerationGraph, inputs: readonly (string | undefined)[], offset: number, pageSize: number = 16) {
    const i = { repositoryId, tag, graphDigest: generationGraphDigest(graph) };
    releaseAssert(Number.isSafeInteger(offset) && offset >= 0 && offset < graph.nodes.length, 'GENERATION_PREPARE_OFFSET');
    await this.db.prepare('INSERT OR IGNORE INTO release_generation_graphs(repository_id,target_tag,graph_digest,policy_sha,source_digest,root_node,node_count,max_runs) VALUES(?,?,?,?,?,?,?,?)')
      .bind(...this.values(i), graph.policySha, graph.sourceDigest, graph.root, graph.nodes.length, graph.maxRuns + 3).run();
    // Bound each request's storage work. Partial/repeated pages never authorize a ticket.
    // The caller must derive graph and inputs from the verified immutable source.
    releaseAssert(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 16, 'GENERATION_PAGE_LIMIT');
    const nextOffset = Math.min(offset + pageSize, graph.nodes.length);
    for (let index = offset; index < nextOffset; index++) {
      const node = graph.nodes[index]!;
      if (node.kind === 'source') {
        const input = inputs[index];
        releaseAssert(typeof input === 'string' && Buffer.byteLength(input) > 0 && Buffer.byteLength(input) <= limits.inputBytes
          && receiptDigest(input) === node.inputDigest, 'GENERATION_INPUT_BINDING');
        await this.object(repositoryId, input);
      }
      await this.db.prepare('INSERT OR IGNORE INTO release_generation_nodes(repository_id,target_tag,graph_digest,node_id,input_digest,children_json) VALUES(?,?,?,?,?,?)')
        .bind(...this.values(i), node.id, node.inputDigest, canonicalReleaseJson(node.children)).run();
    }
    await this.db.prepare('UPDATE release_generation_graphs SET ready=1 WHERE repository_id=? AND target_tag=? AND graph_digest=? AND node_count=(SELECT COUNT(*) FROM release_generation_nodes WHERE repository_id=? AND target_tag=? AND graph_digest=?)')
      .bind(...this.values(i), ...this.values(i)).run();
    return { ...i, nextOffset, ready: (await this.graph(i))?.ready === 1 };
  }
  async ticket(i: GraphIdentity, policySha: string, now: number): Promise<string> {
    const token = 'release-generation-graph.' + randomBytes(32).toString('hex');
    const digest = receiptDigest(token);
    const completed = 'EXISTS(SELECT 1 FROM release_generation_nodes n WHERE n.repository_id=release_generation_graphs.repository_id AND n.target_tag=release_generation_graphs.target_tag AND n.graph_digest=release_generation_graphs.graph_digest AND n.node_id=release_generation_graphs.root_node AND n.output_digest IS NOT NULL)';
    const results = await this.db.batch([
      this.db.prepare(`UPDATE release_generation_graphs SET ticket_digest=?,ticket_until=?,runs=runs+CASE WHEN ${completed} THEN 0 ELSE 1 END,run_calls=0,version=version+1 WHERE repository_id=? AND target_tag=? AND graph_digest=? AND policy_sha=? AND ready=1 AND (runs<max_runs OR ${completed}) AND (ticket_digest IS NULL OR ticket_until<=?)`)
        .bind(digest, now + limits.runTimeoutMs + 30 * 60000, ...this.values(i), policySha, now),
      // Preserve legacy history while preventing old inline-ledger workers from
      // continuing after the authenticated issuer selects the durable protocol.
      this.db.prepare('UPDATE release_generation SET ticket_digest=NULL,ticket_until=0,version=version+1 WHERE repository_id=? AND target_tag=? AND EXISTS(SELECT 1 FROM release_generation_graphs WHERE repository_id=? AND target_tag=? AND graph_digest=? AND ticket_digest=?)')
        .bind(i.repositoryId, i.tag, ...this.values(i), digest),
    ]);
    releaseAssert(results[0]!.meta.changes === 1, 'GENERATION_TICKET_BUSY'); return token;
  }
  async continuation(i: GraphIdentity, policySha: string, now: number): Promise<string> {
    const graph = await this.graph(i);
    releaseAssert(graph?.ready === 1 && graph.policy_sha === policySha && graph.runs > 0
      && graph.runs < graph.max_runs && graph.ticket_until <= now
      && !graph.ticket_digest?.startsWith('continuation:'), 'GENERATION_CONTINUATION');
    const root = await this.node(i, graph.root_node);
    releaseAssert(root && !root.output_digest, 'GENERATION_ALREADY_COMPLETE');
    // Claim once before external dispatch; unknown outcomes retain the marker.
    // Issuing the next authenticated ticket consumes the continuation marker.
    const claimed = await this.db.prepare('UPDATE release_generation_graphs SET ticket_digest=?,version=version+1 WHERE repository_id=? AND target_tag=? AND graph_digest=? AND policy_sha=? AND version=? AND ticket_until<=?')
      .bind(`continuation:${graph.version}`, ...this.values(i), policySha, graph.version, now).run();
    releaseAssert(claimed.meta.changes === 1, 'GENERATION_CONTINUATION');
    return `continuation:${graph.version}`;

  }
  async releaseContinuation(i: GraphIdentity, policySha: string, reservation: string): Promise<void> {
    releaseAssert(/^continuation:[0-9]+$/.test(reservation), 'GENERATION_CONTINUATION');
    const version = Number(reservation.slice('continuation:'.length));
    releaseAssert(Number.isSafeInteger(version) && version >= 0, 'GENERATION_CONTINUATION');
    const result = await this.db.prepare('UPDATE release_generation_graphs SET ticket_digest=NULL,version=version+1 WHERE repository_id=? AND target_tag=? AND graph_digest=? AND policy_sha=? AND ticket_digest=? AND version=?')
      .bind(...this.values(i), policySha, reservation, version + 1).run();
    releaseAssert(result.meta.changes === 1, 'GENERATION_CONTINUATION_STALE');
  }
  private async authorize(lease: GraphLease): Promise<GraphRow> {
    const row = await this.graph(lease);
    releaseAssert(row?.ready === 1 && row.policy_sha === lease.policySha
      && row.ticket_digest === receiptDigest(lease.token) && row.ticket_until > lease.now(), 'GENERATION_AUTH');
    return row;
  }
  async authenticate(lease: GraphLease): Promise<void> { await this.authorize(lease); }
  async sourcePart(lease: GraphLease, part: number) {
    const graph = await this.authorize(lease);
    releaseAssert(Number.isSafeInteger(part) && part >= 0 && part < 2048, 'GENERATION_SOURCE_PART');
    const chunk = await this.objects.getChunk(lease.repositoryId, graph.source_digest, part);
    releaseAssert(chunk, 'GENERATION_SOURCE_MISSING');
    return chunk;
  }
  async status(lease: GraphLease) {
    const graph = await this.authorize(lease);
    const rows = await this.db.prepare('SELECT * FROM release_generation_nodes WHERE repository_id=? AND target_tag=? AND graph_digest=? ORDER BY node_id')
      .bind(...this.values(lease)).all<NodeRow>();
    const completed = new Set(rows.results.filter(n => n.output_digest !== null).map(n => n.node_id));
    const ready = rows.results.filter(n => !n.output_digest && n.attempts < limits.attemptsPerNode
      && (!n.reservation || n.reserved_ticket !== graph.ticket_digest)
      && (JSON.parse(n.children_json) as string[]).every(id => completed.has(id))).map(n => n.node_id);
    return { root: graph.root_node, complete: completed.has(graph.root_node), ready,
      callsRemaining: limits.callsPerRun - graph.run_calls, runsRemaining: graph.max_runs - graph.runs };
  }
  async reserve(lease: GraphLease, id: string) {
    const graph = await this.authorize(lease), node = await this.node(lease, id);
    releaseAssert(node && !node.output_digest && node.attempts < limits.attemptsPerNode
      && (!node.reservation || node.reserved_ticket !== graph.ticket_digest), 'GENERATION_NODE_BUSY');
    const children: string[] = JSON.parse(node.children_json), outputs: unknown[] = [];
    for (const child of children) {
      const row = await this.node(lease, child);
      releaseAssert(row?.output_digest, 'GENERATION_DEPENDENCY');
      outputs.push(JSON.parse(Buffer.from(await this.objects.readObject(lease.repositoryId, row.output_digest)).toString('utf8')));
    }
    const input = node.input_digest
      ? Buffer.from(await this.objects.readObject(lease.repositoryId, node.input_digest)).toString('utf8')
      : canonicalReleaseJson({ sourceDigest: graph.source_digest, children, instruction: 'Reconcile all child summaries, preserving evidence associations, uncertainty and reverted changes.', batches: outputs });
    releaseAssert(Buffer.byteLength(input) <= limits.inputBytes, 'GENERATION_INPUT');
    const reservation = randomBytes(24).toString('hex'), ticket = receiptDigest(lease.token), now = lease.now();
    const results = await this.db.batch([
      this.db.prepare('UPDATE release_generation_graphs SET run_calls=run_calls+1,version=version+1,mutation_nonce=? WHERE repository_id=? AND target_tag=? AND graph_digest=? AND version=? AND ticket_digest=? AND ticket_until>? AND run_calls<?')
        .bind(reservation, ...this.values(lease), graph.version, ticket, now, limits.callsPerRun),
      this.db.prepare('UPDATE release_generation_nodes SET attempts=attempts+1,reservation=?,reserved_ticket=? WHERE repository_id=? AND target_tag=? AND graph_digest=? AND node_id=? AND attempts=? AND output_digest IS NULL AND EXISTS(SELECT 1 FROM release_generation_graphs g WHERE g.repository_id=release_generation_nodes.repository_id AND g.target_tag=release_generation_nodes.target_tag AND g.graph_digest=release_generation_nodes.graph_digest AND g.version=? AND g.mutation_nonce=? AND g.ticket_digest=? AND g.ticket_until>?)')
        .bind(reservation, ticket, ...this.values(lease), id, node.attempts, graph.version + 1, reservation, ticket, now),
    ]);
    releaseAssert(results.every(r => r.meta.changes === 1), 'GENERATION_STALE');
    const diagnostic = node.diagnostic_digest
      ? Buffer.from(await this.objects.readObject(lease.repositoryId, node.diagnostic_digest)).toString('utf8')
      : null;
    return { reservation, input, inputDigest: receiptDigest(input), diagnostic,
      outputBytes: id === graph.root_node ? limits.rootOutputBytes : limits.outputBytes };
  }
  async finish(lease: GraphLease, id: string, reservation: string, output: string, diagnostic = false): Promise<void> {
    const graph = await this.authorize(lease);
    const node = await this.node(lease, id);
    releaseAssert(node && node.output_digest === null && node.reservation === reservation
      && node.reserved_ticket === receiptDigest(lease.token), 'GENERATION_STALE');
    releaseAssert(Buffer.byteLength(output) > 0 && Buffer.byteLength(output) <= 64 * 1024, 'GENERATION_LIMIT');
    const normalized = diagnostic ? output : canonicalReleaseJson(parseGeneratedRelease(Buffer.from(output)));
    releaseAssert(diagnostic || Buffer.byteLength(normalized) <= (id === graph.root_node ? limits.rootOutputBytes : limits.outputBytes), 'GENERATION_BATCH_OUTPUT');
    const digest = await this.object(lease.repositoryId, normalized), ticket = receiptDigest(lease.token);
    const result = await this.db.prepare(`UPDATE release_generation_nodes SET ${diagnostic ? 'diagnostic_digest' : 'output_digest'}=?,reservation=NULL WHERE repository_id=? AND target_tag=? AND graph_digest=? AND node_id=? AND reservation=? AND reserved_ticket=? AND output_digest IS NULL AND EXISTS(SELECT 1 FROM release_generation_graphs g WHERE g.repository_id=release_generation_nodes.repository_id AND g.target_tag=release_generation_nodes.target_tag AND g.graph_digest=release_generation_nodes.graph_digest AND g.ticket_digest=? AND g.ticket_until>?)`)
      .bind(digest, ...this.values(lease), id, reservation, ticket, ticket, lease.now()).run();
    releaseAssert(result.meta.changes === 1, 'GENERATION_STALE');
  }
  async result(lease: GraphLease): Promise<string> {
    const graph = await this.authorize(lease), node = await this.node(lease, graph.root_node);
    releaseAssert(node?.output_digest, 'GENERATION_INCOMPLETE');
    return Buffer.from(await this.objects.readObject(lease.repositoryId, node.output_digest)).toString('utf8');
  }
  async yield(lease: GraphLease): Promise<void> {
    await this.authorize(lease);
    const result = await this.db.prepare('UPDATE release_generation_graphs SET ticket_until=0,version=version+1 WHERE repository_id=? AND target_tag=? AND graph_digest=? AND ticket_digest=? AND ticket_until>?')
      .bind(...this.values(lease), receiptDigest(lease.token), lease.now()).run();
    releaseAssert(result.meta.changes === 1, 'GENERATION_AUTH');
  }
}
