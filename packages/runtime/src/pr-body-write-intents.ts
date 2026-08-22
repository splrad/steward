import { createHash } from "node:crypto";
import {
  extractIssueLinksBlock,
  extractManagedPullRequestBlock,
  managedBodyOutsideIssueLinksDigest,
  removeIssueLinksBlock,
  replaceManagedPullRequestBlock,
  upsertIssueLinksBlock,
  verifyIssueLinkConvergence,
} from "../../core/src/index.js";
import type { GitHubClient } from "../../github/src/index.js";

export type PullRequestBodyRegionKind = "managed-pr" | "issue-links";
export type PullRequestBodyWriteStatus = "prepared" | "patched" | "compensating" | "confirmed" | "blocked";

export interface PullRequestBodyWriteIntent {
  repositoryId: number;
  pullRequestNumber: number;
  writeId: string;
  regionKind: PullRequestBodyRegionKind;
  baseSha: string;
  headSha: string;
  issueGeneration: number;
  beforeBodyDigest: string;
  outsideBodyDigest: string;
  targetBlock: string | null;
  targetBodyDigest: string;
  status: PullRequestBodyWriteStatus;
  compensationGeneration: number;
  attemptCount: number;
  deliveryProven: boolean;
  lastDeliveryId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  blockedReason: string | null;
}

interface IntentRow {
  repository_id: number;
  pull_request_number: number;
  write_id: string;
  region_kind: string;
  base_sha: string;
  head_sha: string;
  issue_generation: number;
  before_body_digest: string;
  outside_body_digest: string;
  target_block: string | null;
  target_body_digest: string;
  status: string;
  compensation_generation: number;
  attempt_count: number;
  delivery_proven: number;
  last_delivery_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  confirmed_at: string | null;
  blocked_reason: string | null;
}

const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const writeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const deliveryPattern = /^[A-Za-z0-9_.:-]{1,200}$/u;

function positiveInteger(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name}无效`);
  return result;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${name}无效`);
  return result;
}

function requireDigest(value: unknown, name: string): string {
  const result = String(value ?? "");
  if (!digestPattern.test(result)) throw new Error(`${name}无效`);
  return result;
}

function requireSha(value: unknown, name: string): string {
  const result = String(value ?? "");
  if (!shaPattern.test(result)) throw new Error(`${name}无效`);
  return result;
}

function affected(result: D1Result): number {
  return Number(result.meta?.changes ?? 0);
}

function intent(row: IntentRow | null): PullRequestBodyWriteIntent | null {
  if (!row) return null;
  if (!writeIdPattern.test(row.write_id) || !["managed-pr", "issue-links"].includes(row.region_kind)
    || !["prepared", "patched", "compensating", "confirmed", "blocked"].includes(row.status)) throw new Error("正文写意图数据无效");
  return {
    repositoryId: positiveInteger(row.repository_id, "repositoryId"),
    pullRequestNumber: positiveInteger(row.pull_request_number, "pullRequestNumber"),
    writeId: row.write_id,
    regionKind: row.region_kind as PullRequestBodyRegionKind,
    baseSha: requireSha(row.base_sha, "baseSha"),
    headSha: requireSha(row.head_sha, "headSha"),
    issueGeneration: nonNegativeInteger(row.issue_generation, "issueGeneration"),
    beforeBodyDigest: requireDigest(row.before_body_digest, "beforeBodyDigest"),
    outsideBodyDigest: requireDigest(row.outside_body_digest, "outsideBodyDigest"),
    targetBlock: row.target_block,
    targetBodyDigest: requireDigest(row.target_body_digest, "targetBodyDigest"),
    status: row.status as PullRequestBodyWriteStatus,
    compensationGeneration: nonNegativeInteger(row.compensation_generation, "compensationGeneration"),
    attemptCount: nonNegativeInteger(row.attempt_count, "attemptCount"),
    deliveryProven: row.delivery_proven === 1,
    lastDeliveryId: row.last_delivery_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    blockedReason: row.blocked_reason,
  };
}

export function pullRequestBodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function bodyOutsideManagedRegionDigest(body: string, regionKind: PullRequestBodyRegionKind): string {
  if (regionKind === "issue-links") return managedBodyOutsideIssueLinksDigest(body);
  const region = extractManagedPullRequestBlock(body);
  return pullRequestBodyDigest(`${body.slice(0, region.start)}${body.slice(region.end)}`);
}

export function managedRegionBlock(body: string, regionKind: PullRequestBodyRegionKind): string | null {
  if (regionKind === "managed-pr") return extractManagedPullRequestBlock(body).block;
  return extractIssueLinksBlock(body)?.block ?? null;
}

export function applyManagedRegion(body: string, regionKind: PullRequestBodyRegionKind, targetBlock: string | null): string {
  if (regionKind === "managed-pr") {
    if (targetBlock === null) throw new Error("拉取请求受管块不能删除");
    return replaceManagedPullRequestBlock(body, targetBlock);
  }
  return targetBlock === null ? removeIssueLinksBlock(body) : upsertIssueLinksBlock(body, targetBlock);
}

export class PullRequestBodyWriteIntentStore {
  constructor(private readonly db: D1Database) {}

  async issueGeneration(repositoryId: number): Promise<number> {
    const row = await this.db.prepare("SELECT generation FROM issue_snapshot_repositories WHERE repository_id = ?").bind(repositoryId).first<{ generation: number }>();
    return row ? nonNegativeInteger(row.generation, "generation") : 0;
  }

  async get(repositoryId: number, pullRequestNumber: number): Promise<PullRequestBodyWriteIntent | null> {
    const row = await this.db.prepare("SELECT * FROM pull_request_body_write_intents WHERE repository_id = ? AND pull_request_number = ?")
      .bind(positiveInteger(repositoryId, "repositoryId"), positiveInteger(pullRequestNumber, "pullRequestNumber")).first<IntentRow>();
    return intent(row);
  }

  async prepare(input: {
    repositoryId: number;
    pullRequestNumber: number;
    writeId: string;
    regionKind: PullRequestBodyRegionKind;
    baseSha: string;
    headSha: string;
    issueGeneration: number;
    beforeBodyDigest: string;
    outsideBodyDigest: string;
    targetBlock: string | null;
    targetBodyDigest: string;
    now: string;
    expiresAt: string;
  }): Promise<PullRequestBodyWriteIntent> {
    const repositoryId = positiveInteger(input.repositoryId, "repositoryId");
    const pullRequestNumber = positiveInteger(input.pullRequestNumber, "pullRequestNumber");
    if (!writeIdPattern.test(input.writeId)) throw new Error("writeId无效");
    if (!["managed-pr", "issue-links"].includes(input.regionKind)) throw new Error("regionKind无效");
    if (input.targetBlock !== null && Buffer.byteLength(input.targetBlock, "utf8") > 256 * 1024) throw new Error("目标受管块过大");
    if (input.regionKind === "managed-pr" && (input.targetBlock === null || managedRegionBlock(input.targetBlock, "managed-pr") !== input.targetBlock)) throw new Error("目标拉取请求受管块无效");
    if (input.regionKind === "issue-links" && input.targetBlock !== null && managedRegionBlock(input.targetBlock, "issue-links") !== input.targetBlock) throw new Error("目标议题受管块无效");
    const values = [repositoryId, pullRequestNumber, input.writeId, input.regionKind, requireSha(input.baseSha, "baseSha"), requireSha(input.headSha, "headSha"),
      nonNegativeInteger(input.issueGeneration, "issueGeneration"), requireDigest(input.beforeBodyDigest, "beforeBodyDigest"), requireDigest(input.outsideBodyDigest, "outsideBodyDigest"),
      input.targetBlock, requireDigest(input.targetBodyDigest, "targetBodyDigest"), input.now, input.now, input.expiresAt];
    const result = await this.db.prepare(`INSERT INTO pull_request_body_write_intents
      (repository_id, pull_request_number, write_id, region_kind, base_sha, head_sha, issue_generation, before_body_digest, outside_body_digest, target_block, target_body_digest, status, compensation_generation, attempt_count, delivery_proven, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, 0, 0, ?, ?, ?)
      ON CONFLICT(repository_id, pull_request_number) DO UPDATE SET
        write_id=excluded.write_id, region_kind=excluded.region_kind, base_sha=excluded.base_sha, head_sha=excluded.head_sha,
        issue_generation=excluded.issue_generation, before_body_digest=excluded.before_body_digest, outside_body_digest=excluded.outside_body_digest,
        target_block=excluded.target_block, target_body_digest=excluded.target_body_digest, status='prepared', compensation_generation=0,
        attempt_count=0, delivery_proven=0, last_delivery_id=NULL, created_at=excluded.created_at, updated_at=excluded.updated_at,
        expires_at=excluded.expires_at, confirmed_at=NULL, blocked_reason=NULL
      WHERE pull_request_body_write_intents.status IN ('confirmed','blocked') OR pull_request_body_write_intents.expires_at <= excluded.created_at`).bind(...values).run();
    if (affected(result) !== 1) throw new Error("body-write-intent-conflict");
    return (await this.get(repositoryId, pullRequestNumber))!;
  }

  async markPatched(repositoryId: number, pullRequestNumber: number, writeId: string, now: string): Promise<PullRequestBodyWriteIntent> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='patched', attempt_count=attempt_count+1,
      delivery_proven=0, last_delivery_id=NULL, updated_at=? WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status IN ('prepared','compensating')`)
      .bind(now, repositoryId, pullRequestNumber, writeId).run();
    const current = await this.get(repositoryId, pullRequestNumber);
    if (affected(result) === 1) return current!;
    if (current?.writeId === writeId && ["patched", "confirmed"].includes(current.status)) return current;
    throw new Error("正文写意图状态冲突");
  }

  async proveDelivery(input: { repositoryId: number; pullRequestNumber: number; writeId: string; deliveryId: string; now: string }): Promise<PullRequestBodyWriteIntent> {
    if (!deliveryPattern.test(input.deliveryId)) throw new Error("deliveryId无效");
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET delivery_proven=1, last_delivery_id=?, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status='patched'`)
      .bind(input.deliveryId, input.now, input.repositoryId, input.pullRequestNumber, input.writeId).run();
    if (affected(result) !== 1) throw new Error("正文写意图状态冲突");
    return (await this.get(input.repositoryId, input.pullRequestNumber))!;
  }

  async beginCompensation(input: { repositoryId: number; pullRequestNumber: number; writeId: string; deliveryId: string; beforeBodyDigest: string; outsideBodyDigest: string; targetBodyDigest: string; now: string }): Promise<PullRequestBodyWriteIntent> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='compensating', compensation_generation=compensation_generation+1,
      before_body_digest=?, outside_body_digest=?, target_body_digest=?, delivery_proven=0, last_delivery_id=?, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status='patched' AND compensation_generation < 4 AND expires_at > ?`)
      .bind(requireDigest(input.beforeBodyDigest, "beforeBodyDigest"), requireDigest(input.outsideBodyDigest, "outsideBodyDigest"), requireDigest(input.targetBodyDigest, "targetBodyDigest"),
        input.deliveryId, input.now, input.repositoryId, input.pullRequestNumber, input.writeId, input.now).run();
    if (affected(result) !== 1) throw new Error("正文补偿上限或状态冲突");
    return (await this.get(input.repositoryId, input.pullRequestNumber))!;
  }

  async confirm(repositoryId: number, pullRequestNumber: number, writeId: string, now: string): Promise<PullRequestBodyWriteIntent> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='confirmed', confirmed_at=?, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status='patched' AND delivery_proven=1`)
      .bind(now, now, repositoryId, pullRequestNumber, writeId).run();
    if (affected(result) !== 1) throw new Error("正文写意图尚未得到交付证明");
    return (await this.get(repositoryId, pullRequestNumber))!;
  }

  async block(repositoryId: number, pullRequestNumber: number, writeId: string, reason: string, now: string): Promise<PullRequestBodyWriteIntent> {
    if (!/^[a-z0-9-]{1,80}$/u.test(reason)) throw new Error("blockedReason无效");
    await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='blocked', blocked_reason=?, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status NOT IN ('confirmed','blocked')`)
      .bind(reason, now, repositoryId, pullRequestNumber, writeId).run();
    return (await this.get(repositoryId, pullRequestNumber))!;
  }

  async recordDelivery(input: { deliveryId: string; repositoryId: number; pullRequestNumber: number; writeId: string; outcome: "ignored" | "proven" | "compensated" | "blocked"; now: string }): Promise<boolean> {
    if (!deliveryPattern.test(input.deliveryId)) throw new Error("deliveryId无效");
    const result = await this.db.prepare(`INSERT OR IGNORE INTO pull_request_body_write_deliveries
      (delivery_id, repository_id, pull_request_number, write_id, outcome, processed_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(input.deliveryId, input.repositoryId, input.pullRequestNumber, input.writeId, input.outcome, input.now).run();
    return affected(result) === 1;
  }

  async deliveryProcessed(deliveryId: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT delivery_id FROM pull_request_body_write_deliveries WHERE delivery_id = ?").bind(deliveryId).first<{ delivery_id: string }>();
    return Boolean(row);
  }

  async listRecoverable(now: string, limit = 20): Promise<readonly PullRequestBodyWriteIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("恢复批量无效");
    const rows = await this.db.prepare(`SELECT * FROM pull_request_body_write_intents
      WHERE status IN ('prepared','patched','compensating') AND expires_at > ? ORDER BY updated_at, repository_id, pull_request_number LIMIT ?`)
      .bind(now, limit).all<IntentRow>();
    return rows.results.map((row) => intent(row)!);
  }

  async blockExpired(now: string, limit = 20): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("过期批量无效");
    const rows = await this.db.prepare(`SELECT repository_id, pull_request_number, write_id FROM pull_request_body_write_intents
      WHERE status IN ('prepared','patched','compensating') AND expires_at <= ? ORDER BY expires_at, repository_id, pull_request_number LIMIT ?`)
      .bind(now, limit).all<{ repository_id: number; pull_request_number: number; write_id: string }>();
    let blocked = 0;
    for (const row of rows.results) {
      const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='blocked', blocked_reason='recovery-window-expired', updated_at=?
        WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status IN ('prepared','patched','compensating') AND expires_at <= ?`)
        .bind(now, row.repository_id, row.pull_request_number, row.write_id, now).run();
      blocked += affected(result);
    }
    return blocked;
  }
}

export type BodyWriteDeliveryOutcome = "none" | "ignored" | "duplicate" | "proven" | "compensated" | "blocked";

function splitRepository(fullName: string): [string, string] {
  const [owner, repo, extra] = fullName.split("/");
  if (!owner || !repo || extra) throw new Error("仓库名称无效");
  return [owner, repo];
}

export async function processPullRequestBodyEditedDelivery(input: {
  store: PullRequestBodyWriteIntentStore;
  client: GitHubClient;
  repository: any;
  payload: any;
  deliveryId: string;
  now: string;
}): Promise<BodyWriteDeliveryOutcome> {
  const repositoryId = positiveInteger(input.repository?.id, "repositoryId");
  const pullRequestNumber = positiveInteger(input.payload?.pull_request?.number, "pullRequestNumber");
  let current = await input.store.get(repositoryId, pullRequestNumber);
  if (!current) return "none";
  if (await input.store.deliveryProcessed(input.deliveryId)) return "duplicate";
  const record = async (outcome: "ignored" | "proven" | "compensated" | "blocked") => {
    await input.store.recordDelivery({ deliveryId: input.deliveryId, repositoryId, pullRequestNumber, writeId: current.writeId, outcome, now: input.now });
    return outcome;
  };
  if (!["prepared", "patched", "compensating"].includes(current.status)) return record("ignored");
  const after = input.payload?.pull_request?.body;
  if (typeof after !== "string" || Buffer.byteLength(after, "utf8") > 1024 * 1024) return record("ignored");
  if (Number(input.payload?.sender?.id) !== 301115370) return record("ignored");
  const before = input.payload?.changes?.body?.from;
  if (typeof before !== "string" || Buffer.byteLength(before, "utf8") > 1024 * 1024) {
    await input.store.block(repositoryId, pullRequestNumber, current.writeId, "edited-evidence-unavailable", input.now);
    return record("blocked");
  }
  if (input.payload.pull_request?.head?.sha !== current.headSha || input.payload.pull_request?.base?.sha !== current.baseSha) {
    await input.store.block(repositoryId, pullRequestNumber, current.writeId, "pull-facts-drifted", input.now);
    return record("blocked");
  }
  const [owner, repo] = splitRepository(String(input.repository.full_name));
  const afterDigest = pullRequestBodyDigest(after);
  if (current.status === "compensating" && afterDigest !== current.targetBodyDigest) {
    try {
      const compensatedBody = applyManagedRegion(before, current.regionKind, current.targetBlock);
      if (pullRequestBodyDigest(compensatedBody) !== current.targetBodyDigest) throw new Error("补偿目标正文摘要不一致");
      const liveBeforeCompensation = await input.client.getPullRequest(owner, repo, pullRequestNumber);
      if (liveBeforeCompensation?.head?.sha !== current.headSha || liveBeforeCompensation?.base?.sha !== current.baseSha || String(liveBeforeCompensation?.body ?? "") !== after) throw new Error("补偿恢复前正文已经漂移");
      const written = await input.client.updatePullRequest(owner, repo, pullRequestNumber, { body: compensatedBody });
      if (written?.head?.sha !== current.headSha || written?.base?.sha !== current.baseSha || String(written?.body ?? "") !== compensatedBody) throw new Error("补偿恢复写入响应不一致");
      await input.store.markPatched(repositoryId, pullRequestNumber, current.writeId, input.now);
      return record("compensated");
    } catch {
      await input.store.block(repositoryId, pullRequestNumber, current.writeId, "compensation-recovery-failed", input.now);
      return record("blocked");
    }
  }
  if (afterDigest !== current.targetBodyDigest) return record("ignored");
  const live = await input.client.getPullRequest(owner, repo, pullRequestNumber);
  if (live?.head?.sha !== current.headSha || live?.base?.sha !== current.baseSha || pullRequestBodyDigest(String(live?.body ?? "")) !== current.targetBodyDigest) {
    await input.store.block(repositoryId, pullRequestNumber, current.writeId, "post-edit-readback-drifted", input.now);
    return record("blocked");
  }
  if (current.status === "prepared" || current.status === "compensating") current = await input.store.markPatched(repositoryId, pullRequestNumber, current.writeId, input.now);
  if (pullRequestBodyDigest(before) === current.beforeBodyDigest) {
    await input.store.proveDelivery({ repositoryId, pullRequestNumber, writeId: current.writeId, deliveryId: input.deliveryId, now: input.now });
    return record("proven");
  }
  try {
    const compensatedBody = applyManagedRegion(before, current.regionKind, current.targetBlock);
    const compensated = await input.store.beginCompensation({
      repositoryId,
      pullRequestNumber,
      writeId: current.writeId,
      deliveryId: input.deliveryId,
      beforeBodyDigest: pullRequestBodyDigest(after),
      outsideBodyDigest: bodyOutsideManagedRegionDigest(compensatedBody, current.regionKind),
      targetBodyDigest: pullRequestBodyDigest(compensatedBody),
      now: input.now,
    });
    const written = await input.client.updatePullRequest(owner, repo, pullRequestNumber, { body: compensatedBody });
    if (written?.head?.sha !== current.headSha || written?.base?.sha !== current.baseSha || String(written?.body ?? "") !== compensatedBody) throw new Error("补偿正文写入响应不一致");
    await input.store.markPatched(repositoryId, pullRequestNumber, compensated.writeId, input.now);
    return record("compensated");
  } catch {
    await input.store.block(repositoryId, pullRequestNumber, current.writeId, "compensation-failed", input.now);
    return record("blocked");
  }
}

export async function confirmPullRequestBodyWriteIntent(input: {
  store: PullRequestBodyWriteIntentStore;
  client: GitHubClient;
  repository: any;
  pullRequestNumber: number;
  writeId: string;
  now: string;
}): Promise<PullRequestBodyWriteIntent> {
  const repositoryId = positiveInteger(input.repository?.id, "repositoryId");
  const current = await input.store.get(repositoryId, input.pullRequestNumber);
  if (!current || current.writeId !== input.writeId || current.status !== "patched" || !current.deliveryProven) throw new Error("正文写意图尚未得到交付证明");
  const [owner, repo] = splitRepository(String(input.repository.full_name));
  const pull = await input.client.getPullRequest(owner, repo, input.pullRequestNumber);
  if (pull?.head?.sha !== current.headSha || pull?.base?.sha !== current.baseSha || pullRequestBodyDigest(String(pull?.body ?? "")) !== current.targetBodyDigest) {
    return input.store.block(repositoryId, input.pullRequestNumber, input.writeId, "confirmation-facts-drifted", input.now);
  }
  if (current.regionKind === "issue-links") {
    const state = await input.store.issueGeneration(repositoryId);
    if (current.issueGeneration > 0 && state !== current.issueGeneration) return input.store.block(repositoryId, input.pullRequestNumber, input.writeId, "issue-generation-drifted", input.now);
    const desired = current.targetBlock ? extractIssueLinksBlock(current.targetBlock)!.metadata.issueNumbers.map((number) => ({ repositoryId, number })) : [];
    const sets = await input.client.listPullRequestClosingIssueSets(owner, repo, input.pullRequestNumber, repositoryId);
    if (!verifyIssueLinkConvergence(desired, sets, repositoryId).converged) throw new Error("GitHub关闭议题集合尚未收敛");
  }
  return input.store.confirm(repositoryId, input.pullRequestNumber, input.writeId, input.now);
}
