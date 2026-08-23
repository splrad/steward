import { createAppJwt, createInstallationToken, GitHubClient, GitHubRequestError, type GitHubIssueFacts, type PageValidator, type ValidatedValue } from "../../github/src/index.js";
import { issueSnapshotContentDigest, normalizeIssueSnapshot, openIssueSetDigest, type IssueRelationSnapshot, type IssueSnapshot } from "../../core/src/issues.js";
import repositoryCatalog from "../../../config/repositories.json" with { type: "json" };

export type IssueSnapshotSyncState = "uninitialized" | "scanning" | "ready" | "degraded";

export interface IssueSnapshotRuntimeEnv {
  ORGANIZATION_ID: string;
  ORGANIZATION_LOGIN: string;
  APP_ID: string;
  INSTALLATION_ID: string;
  POLICY_SHA: string;
  STEWARD_APP_PRIVATE_KEY?: string;
  ISSUE_SNAPSHOTS?: D1Database;
}

export interface IssueSnapshotRepositoryState {
  repositoryId: number;
  generation: number;
  stateRevision: number;
  syncState: IssueSnapshotSyncState;
  openSetDigest: string;
  lastFullScanAt: string | null;
  updatedAt: string;
  reconciliationGeneration?: number | null;
  reconciliationStateRevision?: number | null;
}

export interface StoredIssueSnapshot {
  repositoryId: number;
  issueNumber: number;
  state: "open" | "closed";
  sourceUpdatedAt: string;
  commentsCount: number;
  contentDigest: string;
  validators: readonly PageValidator[];
  snapshot: IssueSnapshot;
  lastDeliveryId: string;
  syncedAt: string;
}

const internalPrefix = "/internal/issue-snapshots/";
const maxOpenSnapshots = 50;
const maxOpenSnapshotBytes = 1024 * 1024;
const maxInternalResponseBytes = 8 * 1024 * 1024;
const deliveryPattern = /^[A-Za-z0-9._:-]{1,200}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const validatorResources = new Set(["issue", "comments", "field-values", "parent", "sub-issues", "blocked-by", "blocking", "open-issues"]);

function positiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${name}无效`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name}无效`);
  return number;
}

function nonNegativeInteger(value: string, name: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error(`${name}无效`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name}无效`);
  return number;
}

function rowInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${name}无效`);
  return Number(value);
}

function parseJson<T>(value: unknown, name: string): T {
  if (typeof value !== "string") throw new Error(`${name}无效`);
  try { return JSON.parse(value) as T; }
  catch { throw new Error(`${name}无效`); }
}

function githubApiUrl(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 4_096) throw new Error(`${name}无效`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name}无效`); }
  if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash) throw new Error(`${name}无效`);
  return url.href;
}

function normalizeValidators(value: unknown): readonly PageValidator[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("validators_json无效");
  return value.map((item, index): PageValidator => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`validator[${index}]无效`);
    const validator = item as Record<string, unknown>;
    if (Object.keys(validator).some((key) => !["resource", "url", "etag", "next", "status"].includes(key))) throw new Error(`validator[${index}]无效`);
    if (!validatorResources.has(String(validator.resource)) || (validator.status !== 200 && validator.status !== 404)
      || (validator.etag !== null && (typeof validator.etag !== "string" || validator.etag.length > 1_024))
      || (validator.next !== null && typeof validator.next !== "string")) throw new Error(`validator[${index}]无效`);
    return {
      resource: validator.resource as PageValidator["resource"],
      url: githubApiUrl(validator.url, `validator[${index}].url`),
      etag: validator.etag as string | null,
      next: validator.next === null ? null : githubApiUrl(validator.next, `validator[${index}].next`),
      status: validator.status,
    };
  });
}

function resultChanges(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

function sameRepositoryState(left: IssueSnapshotRepositoryState | null, right: IssueSnapshotRepositoryState | null): boolean {
  if (!left || !right) return left === right;
  return left.repositoryId === right.repositoryId && left.generation === right.generation && left.stateRevision === right.stateRevision && left.syncState === right.syncState
    && left.openSetDigest === right.openSetDigest && left.lastFullScanAt === right.lastFullScanAt && left.updatedAt === right.updatedAt
    && left.reconciliationGeneration === right.reconciliationGeneration && left.reconciliationStateRevision === right.reconciliationStateRevision;
}

function snapshotJsonForSize(snapshot: IssueSnapshot, validators: readonly PageValidator[], contentDigest: string, syncedAt = "9999-12-31T23:59:59.999Z"): string {
  return JSON.stringify({
    repositoryId: snapshot.repository.id,
    issueNumber: snapshot.issue.number,
    state: snapshot.issue.state,
    sourceUpdatedAt: snapshot.issue.updatedAt,
    commentsCount: snapshot.issue.commentsCount,
    contentDigest,
    validators: normalizeValidators(validators),
    snapshot,
    syncedAt,
  });
}

function noStoreResponse(status: number, body?: unknown): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (body !== undefined) headers.set("Content-Type", "application/json; charset=utf-8");
  const serialized = body === undefined ? null : JSON.stringify(body);
  if (serialized !== null && new TextEncoder().encode(serialized).byteLength > maxInternalResponseBytes) return new Response(JSON.stringify({ error: "internal-response-too-large" }), { status: 413, headers });
  return new Response(serialized, { status, headers });
}

async function requireEmptyBody(request: Request): Promise<void> {
  const length = request.headers.get("content-length");
  if (length !== null && length !== "0") throw new Error("内部请求正文必须为空");
  if ((await request.arrayBuffer()).byteLength !== 0) throw new Error("内部请求正文必须为空");
}

function repositoryStateFromRow(row: Record<string, unknown>): IssueSnapshotRepositoryState {
  const syncState = String(row.sync_state) as IssueSnapshotSyncState;
  if (!["uninitialized", "scanning", "ready", "degraded"].includes(syncState)) throw new Error("仓库同步状态无效");
  const openSetDigest = String(row.open_set_digest);
  if (!digestPattern.test(openSetDigest)) throw new Error("仓库开放集合摘要无效");
  return {
    repositoryId: rowInteger(row.repository_id, "repository_id", 1),
    generation: rowInteger(row.generation, "generation"),
    stateRevision: rowInteger(row.state_revision, "state_revision"),
    syncState,
    openSetDigest,
    lastFullScanAt: row.last_full_scan_at === null ? null : String(row.last_full_scan_at),
    updatedAt: String(row.updated_at),
  };
}

function snapshotFromRow(row: Record<string, unknown>): StoredIssueSnapshot {
  const snapshot = parseJson<IssueSnapshot>(row.snapshot_json, "snapshot_json");
  const repositoryId = rowInteger(row.repository_id, "repository_id", 1);
  const issueNumber = rowInteger(row.issue_number, "issue_number", 1);
  if (snapshot.repository.id !== repositoryId || snapshot.issue.number !== issueNumber) throw new Error("issue-repository-mismatch");
  const state = String(row.state);
  if (state !== "open" && state !== "closed") throw new Error("快照状态无效");
  const contentDigest = String(row.content_digest);
  if (!digestPattern.test(contentDigest) || issueSnapshotContentDigest(snapshot) !== contentDigest || snapshot.schemaVersion !== 1
    || snapshot.issue.state !== state || snapshot.issue.updatedAt !== String(row.source_updated_at) || snapshot.issue.commentsCount !== rowInteger(row.comments_count, "comments_count")) throw new Error("议题快照读回校验失败");
  return {
    repositoryId,
    issueNumber,
    state,
    sourceUpdatedAt: String(row.source_updated_at),
    commentsCount: snapshot.issue.commentsCount,
    contentDigest,
    validators: normalizeValidators(parseJson<unknown>(row.validators_json, "validators_json")),
    snapshot,
    lastDeliveryId: String(row.last_delivery_id),
    syncedAt: String(row.synced_at),
  };
}

export class IssueSnapshotStore {
  constructor(private readonly db: D1Database) {}

  private async ensureRepository(repositoryId: number, now: string): Promise<void> {
    rowInteger(repositoryId, "repositoryId", 1);
    const digest = openIssueSetDigest(repositoryId, []);
    await this.db.prepare(`INSERT OR IGNORE INTO issue_snapshot_repositories
      (repository_id, generation, sync_state, open_set_digest, last_full_scan_at, updated_at)
      SELECT ?, 0, 'uninitialized', ?, NULL, ?
      WHERE NOT EXISTS (SELECT 1 FROM issue_snapshot_repository_tombstones WHERE repository_id = ?)`)
      .bind(repositoryId, digest, now, repositoryId).run();
  }

  async activateRepository(repositoryId: number): Promise<void> {
    rowInteger(repositoryId, "repositoryId", 1);
    await this.db.prepare("DELETE FROM issue_snapshot_repository_tombstones WHERE repository_id = ?").bind(repositoryId).run();
  }

  async getRepositoryState(repositoryId: number): Promise<IssueSnapshotRepositoryState | null> {
    rowInteger(repositoryId, "repositoryId", 1);
    const row = await this.db.prepare(`SELECT repository_id, generation, state_revision, sync_state, open_set_digest, last_full_scan_at, updated_at
      FROM issue_snapshot_repositories WHERE repository_id = ?`).bind(repositoryId).first<Record<string, unknown>>();
    if (!row) return null;
    const state = repositoryStateFromRow(row);
    const reconciliation = await this.getReconciliationRequest(repositoryId);
    return { ...state, reconciliationGeneration: reconciliation?.generation ?? null, reconciliationStateRevision: reconciliation?.stateRevision ?? null };
  }

  async getReconciliationRequest(repositoryId: number): Promise<{ repositoryId: number; generation: number; stateRevision: number; requestedAt: string } | null> {
    rowInteger(repositoryId, "repositoryId", 1);
    const row = await this.db.prepare(`SELECT repository_id, requested_generation, requested_state_revision, requested_at
      FROM issue_snapshot_reconciliation_requests WHERE repository_id = ?`).bind(repositoryId).first<Record<string, unknown>>();
    return row ? {
      repositoryId: rowInteger(row.repository_id, "repository_id", 1),
      generation: rowInteger(row.requested_generation, "requested_generation"),
      stateRevision: rowInteger(row.requested_state_revision, "requested_state_revision"),
      requestedAt: String(row.requested_at),
    } : null;
  }

  async acknowledgeReconciliation(repositoryId: number, generation: number, stateRevision: number): Promise<boolean> {
    rowInteger(repositoryId, "repositoryId", 1); rowInteger(generation, "generation"); rowInteger(stateRevision, "stateRevision");
    const result = await this.db.prepare(`DELETE FROM issue_snapshot_reconciliation_requests
      WHERE repository_id = ? AND requested_generation = ? AND requested_state_revision = ?`).bind(repositoryId, generation, stateRevision).run();
    return resultChanges(result) === 1;
  }

  async getSnapshot(repositoryId: number, issueNumber: number): Promise<StoredIssueSnapshot | null> {
    rowInteger(repositoryId, "repositoryId", 1); rowInteger(issueNumber, "issueNumber", 1);
    const row = await this.db.prepare(`SELECT repository_id, issue_number, state, source_updated_at, comments_count,
      content_digest, validators_json, snapshot_json, last_delivery_id, synced_at
      FROM issue_snapshots WHERE repository_id = ? AND issue_number = ?`)
      .bind(repositoryId, issueNumber).first<Record<string, unknown>>();
    return row ? snapshotFromRow(row) : null;
  }

  async listOpenSnapshots(repositoryId: number): Promise<readonly StoredIssueSnapshot[]> {
    rowInteger(repositoryId, "repositoryId", 1);
    const result = await this.db.prepare(`SELECT repository_id, issue_number, state, source_updated_at, comments_count,
      content_digest, validators_json, snapshot_json, last_delivery_id, synced_at
      FROM issue_snapshots WHERE repository_id = ? AND state = 'open' ORDER BY issue_number LIMIT ?`)
      .bind(repositoryId, maxOpenSnapshots + 1).all<Record<string, unknown>>();
    if (result.results.length > maxOpenSnapshots) throw new Error("开放议题快照超过固定上限");
    return result.results.map(snapshotFromRow);
  }

  async readOpenSnapshotView(repositoryId: number): Promise<{ state: IssueSnapshotRepositoryState | null; snapshots: readonly StoredIssueSnapshot[] }> {
    rowInteger(repositoryId, "repositoryId", 1);
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.getRepositoryState(repositoryId);
      const snapshots = await this.listOpenSnapshots(repositoryId);
      const after = await this.getRepositoryState(repositoryId);
      const digest = openIssueSetDigest(repositoryId, snapshots.map((item) => item.issueNumber));
      if (sameRepositoryState(before, after) && digest === (after?.openSetDigest ?? openIssueSetDigest(repositoryId, []))) return { state: after, snapshots };
    }
    throw new Error("仓库开放集合摘要读回不一致");
  }

  async putSnapshot(input: { expectedGeneration: number; expectedStateRevision: number; snapshot: IssueSnapshot; contentDigest: string; validators: readonly PageValidator[]; deliveryId: string; now: string }): Promise<{ changed: boolean; state: IssueSnapshotRepositoryState }> {
    const repositoryId = input.snapshot.repository.id;
    const issueNumber = input.snapshot.issue.number;
    rowInteger(input.expectedGeneration, "expectedGeneration");
    rowInteger(issueNumber, "issueNumber", 1);
    rowInteger(input.expectedStateRevision, "expectedStateRevision");
    if (!digestPattern.test(input.contentDigest) || issueSnapshotContentDigest(input.snapshot) !== input.contentDigest) throw new Error("议题快照摘要无效");
    await this.ensureRepository(repositoryId, input.now);
    const before = await this.getRepositoryState(repositoryId);
    if (!before || before.generation !== input.expectedGeneration || before.stateRevision !== input.expectedStateRevision) throw new Error("issue-snapshot-generation-conflict");
    const existing = await this.getSnapshot(repositoryId, issueNumber);
    const changed = existing?.contentDigest !== input.contentDigest;
    const currentOpen = await this.listOpenSnapshots(repositoryId);
    const projectedOpen = currentOpen.filter((item) => item.issueNumber !== issueNumber);
    const openNumbers = projectedOpen.map((item) => item.issueNumber);
    if (input.snapshot.issue.state === "open") openNumbers.push(issueNumber);
    const projectedBytes = projectedOpen.reduce((total, item) => total + new TextEncoder().encode(JSON.stringify(publicSnapshot(item))).byteLength, 0)
      + (input.snapshot.issue.state === "open" ? new TextEncoder().encode(snapshotJsonForSize(input.snapshot, input.validators, input.contentDigest, input.now)).byteLength : 0);
    if (openNumbers.length > maxOpenSnapshots || projectedBytes > maxOpenSnapshotBytes) throw new Error("开放议题候选超过固定上限");
    const openDigest = openIssueSetDigest(repositoryId, openNumbers);
    const validatorsJson = JSON.stringify(normalizeValidators(input.validators));
    const snapshotJson = JSON.stringify(input.snapshot);
    if (!changed) {
      const results = await this.db.batch([
        this.db.prepare(`UPDATE issue_snapshots SET source_updated_at = ?, comments_count = ?, validators_json = ?,
          snapshot_json = ?, last_delivery_id = ?, synced_at = ?
          WHERE repository_id = ? AND issue_number = ? AND content_digest = ?
          AND EXISTS (SELECT 1 FROM issue_snapshot_repositories WHERE repository_id = ? AND generation = ? AND state_revision = ?)`)
          .bind(input.snapshot.issue.updatedAt, input.snapshot.issue.commentsCount, validatorsJson, snapshotJson, input.deliveryId, input.now, repositoryId, issueNumber, input.contentDigest, repositoryId, input.expectedGeneration, input.expectedStateRevision),
        this.db.prepare(`UPDATE issue_snapshot_repositories SET updated_at = ?
          WHERE repository_id = ? AND generation = ? AND state_revision = ? AND open_set_digest = ?`)
          .bind(input.now, repositoryId, input.expectedGeneration, input.expectedStateRevision, openDigest),
      ]);
      if (resultChanges(results[0]) !== 1 || resultChanges(results[1]) !== 1) throw new Error("issue-snapshot-generation-conflict");
    } else {
      const results = await this.db.batch([
        this.db.prepare(`INSERT INTO issue_snapshots
          (repository_id, issue_number, state, source_updated_at, comments_count, content_digest, validators_json, snapshot_json, last_delivery_id, synced_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM issue_snapshot_repositories WHERE repository_id = ? AND generation = ? AND state_revision = ?)
          ON CONFLICT(repository_id, issue_number) DO UPDATE SET
            state = excluded.state, source_updated_at = excluded.source_updated_at, comments_count = excluded.comments_count,
            content_digest = excluded.content_digest, validators_json = excluded.validators_json, snapshot_json = excluded.snapshot_json,
            last_delivery_id = excluded.last_delivery_id, synced_at = excluded.synced_at`)
          .bind(repositoryId, issueNumber, input.snapshot.issue.state, input.snapshot.issue.updatedAt, input.snapshot.issue.commentsCount,
            input.contentDigest, validatorsJson, snapshotJson, input.deliveryId, input.now, repositoryId, input.expectedGeneration, input.expectedStateRevision),
        this.db.prepare(`DELETE FROM issue_snapshot_issue_tombstones WHERE repository_id = ? AND issue_number = ?
          AND EXISTS (SELECT 1 FROM issue_snapshot_repositories WHERE repository_id = ? AND generation = ? AND state_revision = ?)
          AND EXISTS (SELECT 1 FROM issue_snapshots WHERE repository_id = ? AND issue_number = ? AND content_digest = ? AND last_delivery_id = ?)`)
          .bind(repositoryId, issueNumber, repositoryId, input.expectedGeneration, input.expectedStateRevision,
            repositoryId, issueNumber, input.contentDigest, input.deliveryId),
        this.db.prepare(`UPDATE issue_snapshot_repositories SET generation = generation + 1, open_set_digest = ?, updated_at = ?
          WHERE repository_id = ? AND generation = ? AND state_revision = ?
          AND EXISTS (SELECT 1 FROM issue_snapshots WHERE repository_id = ? AND issue_number = ? AND content_digest = ?)`)
          .bind(openDigest, input.now, repositoryId, input.expectedGeneration, input.expectedStateRevision, repositoryId, issueNumber, input.contentDigest),
        this.db.prepare(`INSERT INTO issue_snapshot_reconciliation_requests
          (repository_id, requested_generation, requested_state_revision, requested_at)
          SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issue_snapshot_repositories WHERE repository_id = ? AND generation = ? AND state_revision = ?)
          ON CONFLICT(repository_id) DO UPDATE SET requested_generation = excluded.requested_generation,
            requested_state_revision = excluded.requested_state_revision, requested_at = excluded.requested_at`)
          .bind(repositoryId, input.expectedGeneration + 1, input.expectedStateRevision, input.now,
            repositoryId, input.expectedGeneration + 1, input.expectedStateRevision),
      ]);
      if (resultChanges(results[0]) !== 1 || resultChanges(results[2]) !== 1 || resultChanges(results[3]) !== 1) throw new Error("issue-snapshot-generation-conflict");
    }
    const state: IssueSnapshotRepositoryState = {
      ...before,
      generation: input.expectedGeneration + (changed ? 1 : 0),
      openSetDigest: openDigest,
      updatedAt: input.now,
      reconciliationGeneration: changed ? input.expectedGeneration + 1 : before.reconciliationGeneration,
      reconciliationStateRevision: changed ? input.expectedStateRevision : before.reconciliationStateRevision,
    };
    return { changed, state };
  }

  async deleteSnapshot(repositoryId: number, issueNumber: number, expectedGeneration: number, expectedStateRevision: number, now: string): Promise<{ changed: boolean; state: IssueSnapshotRepositoryState | null }> {
    rowInteger(repositoryId, "repositoryId", 1); rowInteger(issueNumber, "issueNumber", 1); rowInteger(expectedGeneration, "expectedGeneration"); rowInteger(expectedStateRevision, "expectedStateRevision");
    await this.ensureRepository(repositoryId, now);
    const before = await this.getRepositoryState(repositoryId);
    if (!before) return { changed: false, state: null };
    if (before.generation !== expectedGeneration || before.stateRevision !== expectedStateRevision) throw new Error("issue-snapshot-generation-conflict");
    const tombstone = await this.db.prepare(`SELECT generation FROM issue_snapshot_issue_tombstones
      WHERE repository_id = ? AND issue_number = ?`).bind(repositoryId, issueNumber).first<{ generation: number }>();
    if (tombstone) {
      const results = await this.db.batch([
        this.db.prepare(`UPDATE issue_snapshot_issue_tombstones SET generation = ?, deleted_at = ?
          WHERE repository_id = ? AND issue_number = ?
          AND EXISTS (SELECT 1 FROM issue_snapshot_repositories WHERE repository_id = ? AND generation = ? AND state_revision = ?)`)
          .bind(expectedGeneration, now, repositoryId, issueNumber, repositoryId, expectedGeneration, expectedStateRevision),
        this.db.prepare(`UPDATE issue_snapshot_repositories SET state_revision = state_revision + 1, updated_at = ?
          WHERE repository_id = ? AND generation = ? AND state_revision = ?
          AND EXISTS (SELECT 1 FROM issue_snapshot_issue_tombstones
            WHERE repository_id = ? AND issue_number = ? AND generation = ? AND deleted_at = ?)
          AND NOT EXISTS (SELECT 1 FROM issue_snapshots WHERE repository_id = ? AND issue_number = ?)`)
          .bind(now, repositoryId, expectedGeneration, expectedStateRevision, repositoryId, issueNumber, expectedGeneration, now, repositoryId, issueNumber),
      ]);
      if (resultChanges(results[0]) !== 1 || resultChanges(results[1]) !== 1) throw new Error("issue-snapshot-generation-conflict");
      const state: IssueSnapshotRepositoryState = { ...before, stateRevision: expectedStateRevision + 1, updatedAt: now };
      return { changed: false, state };
    }
    const openNumbers = (await this.listOpenSnapshots(repositoryId)).map((item) => item.issueNumber).filter((number) => number !== issueNumber);
    const openDigest = openIssueSetDigest(repositoryId, openNumbers);
    const results = await this.db.batch([
      this.db.prepare(`DELETE FROM issue_snapshots WHERE repository_id = ? AND issue_number = ?
        AND EXISTS (SELECT 1 FROM issue_snapshot_repositories WHERE repository_id = ? AND generation = ? AND state_revision = ?)`)
        .bind(repositoryId, issueNumber, repositoryId, expectedGeneration, expectedStateRevision),
      this.db.prepare(`INSERT INTO issue_snapshot_issue_tombstones (repository_id, issue_number, generation, deleted_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issue_snapshot_repositories WHERE repository_id = ? AND generation = ? AND state_revision = ?)`)
        .bind(repositoryId, issueNumber, expectedGeneration + 1, now, repositoryId, expectedGeneration, expectedStateRevision),
      this.db.prepare(`UPDATE issue_snapshot_repositories SET generation = generation + 1, open_set_digest = ?, updated_at = ?
        WHERE repository_id = ? AND generation = ? AND state_revision = ?
        AND NOT EXISTS (SELECT 1 FROM issue_snapshots WHERE repository_id = ? AND issue_number = ?)`)
        .bind(openDigest, now, repositoryId, expectedGeneration, expectedStateRevision, repositoryId, issueNumber),
      this.db.prepare(`INSERT INTO issue_snapshot_reconciliation_requests
        (repository_id, requested_generation, requested_state_revision, requested_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issue_snapshot_repositories WHERE repository_id = ? AND generation = ? AND state_revision = ?)
        ON CONFLICT(repository_id) DO UPDATE SET requested_generation = excluded.requested_generation,
          requested_state_revision = excluded.requested_state_revision, requested_at = excluded.requested_at`)
        .bind(repositoryId, expectedGeneration + 1, expectedStateRevision, now,
          repositoryId, expectedGeneration + 1, expectedStateRevision),
    ]);
    if (resultChanges(results[1]) !== 1 || resultChanges(results[2]) !== 1 || resultChanges(results[3]) !== 1) throw new Error("issue-snapshot-generation-conflict");
    const state: IssueSnapshotRepositoryState = {
      ...before,
      generation: expectedGeneration + 1,
      openSetDigest: openDigest,
      updatedAt: now,
      reconciliationGeneration: expectedGeneration + 1,
      reconciliationStateRevision: expectedStateRevision,
    };
    return { changed: true, state };
  }

  async deleteRepository(repositoryId: number): Promise<void> {
    rowInteger(repositoryId, "repositoryId", 1);
    const now = new Date().toISOString();
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO issue_snapshot_repository_tombstones (repository_id, deleted_at) VALUES (?, ?)
        ON CONFLICT(repository_id) DO UPDATE SET deleted_at = excluded.deleted_at`).bind(repositoryId, now),
      this.db.prepare("DELETE FROM issue_snapshots WHERE repository_id = ?").bind(repositoryId),
      this.db.prepare("DELETE FROM issue_snapshot_issue_tombstones WHERE repository_id = ?").bind(repositoryId),
      this.db.prepare("DELETE FROM issue_snapshot_reconciliation_requests WHERE repository_id = ?").bind(repositoryId),
      this.db.prepare("DELETE FROM issue_snapshot_repositories WHERE repository_id = ?").bind(repositoryId),
    ]);
    if (results.length !== 5 || results.some((result) => !result.success)) throw new Error("仓库快照清理失败");
  }

  async deleteAllRepositories(repositoryIds: readonly number[] = []): Promise<void> {
    const result = await this.db.prepare("SELECT repository_id FROM issue_snapshot_repositories ORDER BY repository_id").all<{ repository_id: number }>();
    const targets = new Set(result.results.map(row => rowInteger(row.repository_id, "repository_id", 1)));
    for (const repositoryId of repositoryIds) targets.add(rowInteger(repositoryId, "repositoryId", 1));
    for (const repositoryId of [...targets].sort((left, right) => left - right)) await this.deleteRepository(repositoryId);
  }

  async setScanState(repositoryId: number, syncState: Exclude<IssueSnapshotSyncState, "uninitialized">, expectedGeneration: number, expectedStateRevision: number, now: string, liveOpenNumbers?: readonly number[]): Promise<IssueSnapshotRepositoryState> {
    rowInteger(repositoryId, "repositoryId", 1); rowInteger(expectedGeneration, "expectedGeneration"); rowInteger(expectedStateRevision, "expectedStateRevision");
    await this.ensureRepository(repositoryId, now);
    const before = await this.getRepositoryState(repositoryId);
    if (!before || before.generation !== expectedGeneration || before.stateRevision !== expectedStateRevision) throw new Error("issue-snapshot-generation-conflict");
    let openDigest = before.openSetDigest;
    let lastFullScanAt = before.lastFullScanAt;
    if (syncState === "ready") {
      if (!liveOpenNumbers) throw new Error("ready状态缺少实时开放集合");
      const stored = (await this.listOpenSnapshots(repositoryId)).map((item) => item.issueNumber);
      openDigest = openIssueSetDigest(repositoryId, liveOpenNumbers);
      if (openDigest !== openIssueSetDigest(repositoryId, stored) || openDigest !== before.openSetDigest) throw new Error("开放议题集合尚未收敛");
      lastFullScanAt = now;
    }
    const statements = [this.db.prepare(`UPDATE issue_snapshot_repositories SET sync_state = ?, open_set_digest = ?,
      last_full_scan_at = ?, updated_at = ?, state_revision = state_revision + 1
      WHERE repository_id = ? AND generation = ? AND state_revision = ?`)
      .bind(syncState, openDigest, lastFullScanAt, now, repositoryId, expectedGeneration, expectedStateRevision)];
    if (syncState === "ready") statements.push(this.db.prepare(`INSERT INTO issue_snapshot_reconciliation_requests
      (repository_id, requested_generation, requested_state_revision, requested_at)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM issue_snapshot_repositories
        WHERE repository_id = ? AND generation = ? AND state_revision = ? AND sync_state = 'ready' AND updated_at = ?)
      ON CONFLICT(repository_id) DO UPDATE SET requested_generation = excluded.requested_generation,
        requested_state_revision = excluded.requested_state_revision, requested_at = excluded.requested_at`)
      .bind(repositoryId, expectedGeneration, expectedStateRevision + 1, now,
        repositoryId, expectedGeneration, expectedStateRevision + 1, now));
    const results = await this.db.batch(statements);
    if (resultChanges(results[0]) !== 1 || (syncState === "ready" && resultChanges(results[1]) !== 1)) throw new Error("issue-snapshot-generation-conflict");
    return {
      ...before,
      stateRevision: expectedStateRevision + 1,
      syncState,
      openSetDigest: openDigest,
      lastFullScanAt,
      updatedAt: now,
      reconciliationGeneration: syncState === "ready" ? expectedGeneration : before.reconciliationGeneration,
      reconciliationStateRevision: syncState === "ready" ? expectedStateRevision + 1 : before.reconciliationStateRevision,
    };
  }
}

function relationFromGitHub(value: any): IssueRelationSnapshot {
  const repositoryId = Number(value?.repository?.id ?? value?.repository_id);
  return { repositoryId, number: Number(value?.number), title: String(value?.title ?? ""), state: value?.state, updatedAt: String(value?.updated_at ?? "") };
}

function fieldValueFromGitHub(value: any): { name: string; type: string; value: any } {
  const type = String(value?.data_type ?? "unknown");
  let currentValue = value?.value ?? null;
  if (type === "single_select" && value?.single_select_option) currentValue = {
    id: value.single_select_option.id, name: value.single_select_option.name, color: value.single_select_option.color,
  };
  if (type === "multi_select" && Array.isArray(value?.multi_select_options)) currentValue = value.multi_select_options.map((option: any) => ({ id: option?.id, name: option?.name, color: option?.color }));
  return {
    name: String(value?.issue_field_name ?? ""),
    type,
    value: currentValue,
  };
}

function relationRepositoryPath(value: any): string {
  try {
    const url = new URL(String(value?.repository_url));
    if (url.origin !== "https://api.github.com" || !/^\/repos\/[^/]+\/[^/]+$/u.test(url.pathname)) throw new Error();
    return url.pathname.slice("/repos/".length);
  } catch { throw new Error("议题关系仓库身份无效"); }
}

async function hydrateRelationRepositoryIds(client: GitHubClient, repository: any, facts: GitHubIssueFacts, env: IssueSnapshotRuntimeEnv): Promise<GitHubIssueFacts> {
  const currentFullName = String(repository.full_name);
  const ids = new Map<string, number>([[currentFullName.toLowerCase(), Number(repository.id)]]);
  const values = [facts.parent, ...facts.subIssues, ...facts.blockedBy, ...facts.blocking].filter(Boolean);
  for (const value of values) {
    const fullName = relationRepositoryPath(value);
    if (ids.has(fullName.toLowerCase())) continue;
    const [owner, repo] = fullName.split("/") as [string, string];
    if (owner.toLowerCase() !== env.ORGANIZATION_LOGIN.toLowerCase() || !env.STEWARD_APP_PRIVATE_KEY) throw new Error("议题关系仓库身份无效");
    const token = await createInstallationToken({
      appId: env.APP_ID,
      privateKey: env.STEWARD_APP_PRIVATE_KEY,
      installationId: Number(env.INSTALLATION_ID),
      repositoryName: repo,
      permissions: { issues: "read", metadata: "read" },
      policySha: env.POLICY_SHA,
    });
    const relatedClient = new GitHubClient(token, "https://api.github.com", fetch, env.POLICY_SHA);
    const relatedRepository = await relatedClient.getRepository(owner, repo);
    if (!Number.isSafeInteger(relatedRepository?.id) || relatedRepository.id <= 0 || String(relatedRepository?.full_name).toLowerCase() !== fullName.toLowerCase()) throw new Error("议题关系仓库身份无效");
    const override = (repositoryCatalog.repositories as Record<string, any>)[String(relatedRepository.id)];
    if (override?.fullName && override.fullName !== relatedRepository.full_name) throw new Error("议题关系仓库身份无效");
    const configuration = { ...(relatedRepository.private ? repositoryCatalog.defaults.private : repositoryCatalog.defaults.public), ...(override ?? {}) };
    if (relatedRepository.private !== false || configuration.managed !== true) throw new Error("议题关系仓库不允许进入快照");
    ids.set(fullName.toLowerCase(), relatedRepository.id);
  }
  const hydrate = (value: any) => value ? { ...value, repository: { id: ids.get(relationRepositoryPath(value).toLowerCase()) } } : null;
  return {
    ...facts,
    parent: hydrate(facts.parent),
    subIssues: facts.subIssues.map(hydrate),
    blockedBy: facts.blockedBy.map(hydrate),
    blocking: facts.blocking.map(hydrate),
  };
}

export function normalizeGitHubIssueFacts(repository: any, facts: GitHubIssueFacts): IssueSnapshot {
  const issue = facts.issue;
  return normalizeIssueSnapshot({
    repository: { id: Number(repository.id), fullName: String(repository.full_name) },
    issue: {
      number: Number(issue.number), title: String(issue.title ?? ""), body: String(issue.body ?? ""), state: issue.state,
      labels: (issue.labels ?? []).map((label: any) => typeof label === "string" ? label : String(label?.name ?? "")),
      milestone: issue.milestone ? { number: Number(issue.milestone.number), title: String(issue.milestone.title ?? ""), state: issue.milestone.state, dueOn: issue.milestone.due_on ?? null } : null,
      stateReason: issue.state_reason ?? null,
      issueType: issue.type?.name ?? issue.issue_type?.name ?? null,
      fieldValues: facts.fieldValues.map(fieldValueFromGitHub),
      createdAt: String(issue.created_at ?? ""), updatedAt: String(issue.updated_at ?? ""), commentsCount: Number(issue.comments),
    },
    comments: facts.comments.map((comment: any) => ({ id: Number(comment.id), author: String(comment.user?.login ?? "ghost"), body: String(comment.body ?? ""), createdAt: String(comment.created_at ?? ""), updatedAt: String(comment.updated_at ?? comment.created_at ?? "") })),
    parent: facts.parent ? relationFromGitHub(facts.parent) : null,
    subIssues: facts.subIssues.map(relationFromGitHub), blockedBy: facts.blockedBy.map(relationFromGitHub), blocking: facts.blocking.map(relationFromGitHub),
  });
}

async function authorizeSingleRepository(request: Request, env: IssueSnapshotRuntimeEnv, repositoryId: number): Promise<{ repository: any; client: GitHubClient }> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]{1,4096})$/u);
  if (!match) throw new GitHubRequestError(401, "GET", "/installation/repositories", "missing-bearer");
  const client = new GitHubClient(match[1]!, "https://api.github.com", fetch, env.POLICY_SHA);
  const repositories = await client.listInstallationRepositories();
  if (repositories.length !== 1) throw new GitHubRequestError(403, "GET", "/installation/repositories", "token-repository-scope");
  const repository = repositories[0];
  if (Number(repository?.id) !== repositoryId || typeof repository?.full_name !== "string") throw new GitHubRequestError(403, "GET", "/installation/repositories", "issue-repository-mismatch");
  const [owner, repo, extra] = repository.full_name.split("/");
  if (!owner || !repo || extra || owner.toLowerCase() !== env.ORGANIZATION_LOGIN.toLowerCase() || Number(repository?.owner?.id) !== Number(env.ORGANIZATION_ID)) throw new GitHubRequestError(403, "GET", "/installation/repositories", "repository-scope");
  if (!env.STEWARD_APP_PRIVATE_KEY) throw new Error("缺少应用私钥");
  const appJwt = await createAppJwt(env.APP_ID, env.STEWARD_APP_PRIVATE_KEY);
  const appClient = new GitHubClient(appJwt, "https://api.github.com", fetch, env.POLICY_SHA);
  const [installation, app, viewer] = await Promise.all([
    appClient.request<any>("GET", `/repos/${owner}/${repo}/installation`),
    appClient.request<any>("GET", "/app"),
    client.request<any>("POST", "/graphql", { query: "query InternalTokenViewer { viewer { login } }" }),
  ]);
  if (Number(installation?.id) !== Number(env.INSTALLATION_ID) || Number(installation?.app_id) !== Number(env.APP_ID)) throw new GitHubRequestError(403, "GET", `/repos/${owner}/${repo}/installation`, "installation-mismatch");
  if (Number(app?.id) !== Number(env.APP_ID) || typeof app?.slug !== "string" || viewer?.errors?.length
    || String(viewer?.data?.viewer?.login).toLowerCase() !== `${app.slug}[bot]`.toLowerCase()) throw new GitHubRequestError(403, "POST", "/graphql", "app-identity-mismatch");
  const current = await client.getRepository(owner, repo);
  if (Number(current?.id) !== repositoryId || String(current?.full_name).toLowerCase() !== repository.full_name.toLowerCase()) throw new GitHubRequestError(403, "GET", `/repos/${owner}/${repo}`, "issue-repository-mismatch");
  const override = (repositoryCatalog.repositories as Record<string, any>)[String(repositoryId)];
  if (override?.fullName && override.fullName !== current.full_name) throw new GitHubRequestError(403, "GET", `/repos/${owner}/${repo}`, "repository-catalog-mismatch");
  const configuration = { ...(current.private ? repositoryCatalog.defaults.private : repositoryCatalog.defaults.public), ...(override ?? {}) };
  if (configuration.managed !== true) throw new GitHubRequestError(403, "GET", `/repos/${owner}/${repo}`, "repository-not-managed");
  return { repository: current, client };
}

function repositoryParts(repository: any): [string, string] {
  const parts = String(repository.full_name).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("仓库完整名称无效");
  return parts as [string, string];
}

async function listLiveOpenIssueNumbers(client: GitHubClient, repository: any): Promise<number[]> {
  const [owner, repo] = repositoryParts(repository);
  const result = await client.listOpenIssuesWithValidators(owner, repo);
  const numbers = result.items.filter((item: any) => !Object.hasOwn(item ?? {}, "pull_request")).map((item: any) => {
    const number = Number(item?.number);
    let path = "";
    try { path = new URL(String(item?.repository_url)).pathname.toLowerCase(); } catch { /* checked below */ }
    if (!Number.isSafeInteger(number) || number <= 0 || path !== `/repos/${owner}/${repo}`.toLowerCase()) throw new Error("issue-repository-mismatch");
    return number;
  }).sort((left, right) => left - right);
  if (new Set(numbers).size !== numbers.length) throw new Error("GitHub开放议题集合重复");
  return numbers;
}

function publicSnapshot(item: StoredIssueSnapshot): Record<string, unknown> {
  return { repositoryId: item.repositoryId, issueNumber: item.issueNumber, state: item.state, sourceUpdatedAt: item.sourceUpdatedAt, commentsCount: item.commentsCount, contentDigest: item.contentDigest, validators: item.validators, snapshot: item.snapshot, syncedAt: item.syncedAt };
}

export async function handleIssueSnapshotInternalRequest(request: Request, env: IssueSnapshotRuntimeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(internalPrefix)) return null;
  if (url.search) return noStoreResponse(400, { error: "internal-query-not-allowed" });
  if (!env.ISSUE_SNAPSHOTS) return noStoreResponse(503, { error: "issue-snapshot-storage-unavailable" });
  const parts = url.pathname.slice(internalPrefix.length).split("/").filter(Boolean);
  let repositoryId: number;
  try { repositoryId = positiveInteger(parts[0] ?? "", "repositoryId"); }
  catch { return noStoreResponse(400, { error: "invalid-repository-id" }); }
  const store = new IssueSnapshotStore(env.ISSUE_SNAPSHOTS);
  try {
    const { repository, client } = await authorizeSingleRepository(request, env, repositoryId);
    if (request.method === "GET" && parts.length === 1) {
      const view = await store.readOpenSnapshotView(repositoryId);
      const state = view.state ?? { repositoryId, generation: 0, stateRevision: 0, syncState: "uninitialized" as const, openSetDigest: openIssueSetDigest(repositoryId, []), lastFullScanAt: null, updatedAt: new Date(0).toISOString() };
      const snapshots = view.snapshots;
      return noStoreResponse(200, { ...state, snapshots: snapshots.map(publicSnapshot) });
    }
    if (request.method === "POST" && parts.length === 2 && parts[1] === "scan-state") {
      await requireEmptyBody(request);
      const requested = request.headers.get("x-steward-scan-state");
      if (requested !== "scanning" && requested !== "degraded" && requested !== "ready") return noStoreResponse(400, { error: "invalid-scan-state" });
      const current = await store.getRepositoryState(repositoryId);
      const expectedGeneration = current?.generation ?? 0;
      const expectedStateRevision = current?.stateRevision ?? 0;
      const live = requested === "ready" ? await listLiveOpenIssueNumbers(client, repository) : undefined;
      const state = await store.setScanState(repositoryId, requested, expectedGeneration, expectedStateRevision, new Date().toISOString(), live);
      return noStoreResponse(200, state);
    }
    if (request.method === "POST" && parts.length === 2 && parts[1] === "reconciliation") {
      await requireEmptyBody(request);
      const generationHeader = request.headers.get("x-steward-reconciliation-generation") ?? "";
      const stateRevisionHeader = request.headers.get("x-steward-reconciliation-state-revision") ?? "";
      let generation: number; let stateRevision: number;
      try { generation = nonNegativeInteger(generationHeader, "generation"); }
      catch { return noStoreResponse(400, { error: "invalid-reconciliation-generation" }); }
      try { stateRevision = nonNegativeInteger(stateRevisionHeader, "stateRevision"); }
      catch { return noStoreResponse(400, { error: "invalid-reconciliation-state-revision" }); }
      const acknowledged = await store.acknowledgeReconciliation(repositoryId, generation, stateRevision);
      return noStoreResponse(200, { repositoryId, generation, stateRevision, acknowledged });
    }
    if (request.method === "POST" && parts.length === 3 && parts[2] === "refresh") {
      await requireEmptyBody(request);
      const issueNumber = positiveInteger(parts[1]!, "issueNumber");
      const deliveryId = request.headers.get("x-github-delivery") ?? "manual";
      if (!deliveryPattern.test(deliveryId)) return noStoreResponse(400, { error: "invalid-delivery-id" });
      const current = await store.getRepositoryState(repositoryId);
      const expectedGeneration = current?.generation ?? 0;
      const expectedStateRevision = current?.stateRevision ?? 0;
      const [owner, repo] = repositoryParts(repository);
      let issue: ValidatedValue<any>;
      try { issue = await client.readIssueWithValidator(owner, repo, issueNumber); }
      catch (error) {
        const authoritativeMissing = error instanceof GitHubRequestError && error.status === 404 && error.path === `/repos/${owner}/${repo}/issues/${issueNumber}`;
        if (!authoritativeMissing) throw error;
        const deleted = await store.deleteSnapshot(repositoryId, issueNumber, expectedGeneration, expectedStateRevision, new Date().toISOString());
        return noStoreResponse(200, { repositoryId, issueNumber, deleted: deleted.changed, generation: deleted.state?.generation ?? 0 });
      }
      if (issue.value?.state === "closed") {
        const deleted = await store.deleteSnapshot(repositoryId, issueNumber, expectedGeneration, expectedStateRevision, new Date().toISOString());
        return noStoreResponse(200, { repositoryId, issueNumber, deleted: deleted.changed, generation: deleted.state?.generation ?? expectedGeneration });
      }
      let facts: GitHubIssueFacts = await client.readIssueFacts(owner, repo, issueNumber, issue);
      facts = await hydrateRelationRepositoryIds(client, repository, facts, env);
      const snapshot = normalizeGitHubIssueFacts(repository, facts);
      if (snapshot.repository.id !== repositoryId || snapshot.issue.number !== issueNumber) throw new Error("issue-repository-mismatch");
      if (snapshot.issue.state === "closed") {
        const deleted = await store.deleteSnapshot(repositoryId, issueNumber, expectedGeneration, expectedStateRevision, new Date().toISOString());
        return noStoreResponse(200, { repositoryId, issueNumber, deleted: deleted.changed, generation: deleted.state?.generation ?? expectedGeneration });
      }
      const contentDigest = issueSnapshotContentDigest(snapshot);
      const saved = await store.putSnapshot({ expectedGeneration, expectedStateRevision, snapshot, contentDigest, validators: facts.validators, deliveryId, now: new Date().toISOString() });
      return noStoreResponse(200, { repositoryId, issueNumber, changed: saved.changed, generation: saved.state.generation, contentDigest });
    }
    return noStoreResponse(404, { error: "internal-route-not-found" });
  } catch (error) {
    if (error instanceof GitHubRequestError) {
      if (error.status === 401) return noStoreResponse(401, { error: "internal-token-rejected" });
      if (error.status === 403 || error.status === 404) return noStoreResponse(403, { error: "internal-scope-rejected" });
      return noStoreResponse(502, { error: "github-read-failed" });
    }
    if (error instanceof Error && error.message === "issue-snapshot-generation-conflict") return noStoreResponse(409, { error: error.message });
    if (error instanceof Error && ["内部请求正文必须为空", "issueNumber无效"].includes(error.message)) return noStoreResponse(400, { error: "invalid-internal-request" });
    return noStoreResponse(503, { error: "issue-snapshot-operation-failed" });
  }
}
