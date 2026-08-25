import { createHash, randomUUID } from "node:crypto";
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
export type PullRequestBodyRedriveWorkflow = "pr-automation.yml" | "onboard-repository.yml" | "sync-copilot-instructions.yml" | "pr-issue-link.yml";
export interface PullRequestBodyRedrive {
  workflow: PullRequestBodyRedriveWorkflow;
  inputs: Readonly<Record<string, string>>;
}

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
  redrive: PullRequestBodyRedrive | null;
  redriveRequired: boolean;
  redriveDispatched: boolean;
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
  redrive_workflow: string | null;
  redrive_inputs: string | null;
  redrive_required: number;
  redrive_dispatched: number;
}

const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const writeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const deliveryPattern = /^[A-Za-z0-9_.:-]{1,200}$/u;
const repositoryNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const redriveContracts: Readonly<Record<PullRequestBodyRedriveWorkflow, readonly string[]>> = {
  "pr-automation.yml": ["deliveryId", "repositoryId", "sourceRef", "eventAfterSha", "sourceActorId", "sourceActorLogin", "policySha"],
  "onboard-repository.yml": ["repositoryId", "repositoryFullName", "trigger", "deliveryId", "policySha"],
  "sync-copilot-instructions.yml": ["repositoryId"],
  "pr-issue-link.yml": ["deliveryId", "repositoryId", "pullRequestNumber", "scanAll", "invalidateOnly", "cleanupUnmanaged", "policySha"],
};

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

function issueLinksMetadataForIntent(block: string, expected: { repositoryId: number; pullRequestNumber: number; baseSha: string; headSha: string; issueGeneration: number }) {
  const region = extractIssueLinksBlock(block);
  if (!region || region.start !== 0 || region.end !== block.length) throw new Error("目标议题受管块无效");
  const metadata = region.metadata;
  if (metadata.repositoryId !== expected.repositoryId || metadata.pullRequestNumber !== expected.pullRequestNumber
    || metadata.baseSha !== expected.baseSha || metadata.headSha !== expected.headSha || metadata.generation !== expected.issueGeneration) {
    throw new Error("目标议题受管块上下文不匹配");
  }
  return metadata;
}

function affected(result: D1Result): number {
  return Number(result.meta?.changes ?? 0);
}

export function normalizePullRequestBodyRedrive(value: unknown, expected: { repositoryId: number; pullRequestNumber: number; regionKind: PullRequestBodyRegionKind }): PullRequestBodyRedrive {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("正文写重调度来源无效");
  const workflow = String((value as any).workflow ?? "") as PullRequestBodyRedriveWorkflow;
  const required = redriveContracts[workflow];
  const rawInputs = (value as any).inputs;
  if (!required || !rawInputs || typeof rawInputs !== "object" || Array.isArray(rawInputs)) throw new Error("正文写重调度来源无效");
  const keys = Object.keys(rawInputs).sort();
  if (keys.length !== required.length || keys.some((key, index) => key !== [...required].sort()[index])) throw new Error("正文写重调度输入无效");
  const inputs = Object.fromEntries(keys.map(key => [key, typeof rawInputs[key] === "string" ? rawInputs[key] : ""]));
  if (Buffer.byteLength(JSON.stringify(inputs), "utf8") > 4096 || Object.values(inputs).some(input => !input || input.length > 1000 || /[\r\n\0]/u.test(input))) throw new Error("正文写重调度输入无效");
  if (inputs.repositoryId !== String(expected.repositoryId)) throw new Error("正文写重调度仓库不匹配");
  if (workflow === "pr-issue-link.yml") {
    if (expected.regionKind !== "issue-links" || inputs.pullRequestNumber !== String(expected.pullRequestNumber)
      || inputs.scanAll !== "false" || inputs.invalidateOnly !== "false" || !/^(?:true|false)$/u.test(inputs.cleanupUnmanaged ?? "")) throw new Error("正文写重调度输入无效");
  } else if (expected.regionKind !== "managed-pr") throw new Error("正文写重调度区域不匹配");
  if (workflow === "pr-automation.yml" && (!deliveryPattern.test(inputs.deliveryId ?? "") || !/^refs\/heads\/.+/u.test(inputs.sourceRef ?? "")
    || !shaPattern.test(inputs.eventAfterSha ?? "") || !/^[1-9][0-9]*$/u.test(inputs.sourceActorId ?? "") || !(inputs.sourceActorLogin ?? "").length)) throw new Error("正文写重调度输入无效");
  if (workflow === "onboard-repository.yml" && (!repositoryNamePattern.test(inputs.repositoryFullName ?? "")
    || !["installation-created", "installation-repositories-added", "repository-visibility-changed", "repository-unarchived", "default-branch-push", "manual"].includes(inputs.trigger ?? "")
    || !deliveryPattern.test(inputs.deliveryId ?? ""))) throw new Error("正文写重调度输入无效");
  if (workflow !== "sync-copilot-instructions.yml" && !shaPattern.test(inputs.policySha ?? "")) throw new Error("正文写重调度输入无效");
  return Object.freeze({ workflow, inputs: Object.freeze(inputs) });
}

function intent(row: IntentRow | null): PullRequestBodyWriteIntent | null {
  if (!row) return null;
  if (!writeIdPattern.test(row.write_id) || !["managed-pr", "issue-links"].includes(row.region_kind)
    || !["prepared", "patched", "compensating", "confirmed", "blocked"].includes(row.status)) throw new Error("正文写意图数据无效");
  const redriveValue = row.redrive_workflow === null && row.redrive_inputs === null ? null : (() => {
    if (!row.redrive_workflow || !row.redrive_inputs) throw new Error("正文写重调度数据无效");
    let inputs: unknown;
    try { inputs = JSON.parse(row.redrive_inputs); } catch { throw new Error("正文写重调度数据无效"); }
    const redriveRegionKind = row.redrive_workflow === "pr-issue-link.yml" ? "issue-links" : "managed-pr";
    return normalizePullRequestBodyRedrive({ workflow: row.redrive_workflow, inputs }, { repositoryId: row.repository_id, pullRequestNumber: row.pull_request_number, regionKind: redriveRegionKind });
  })();
  const result: PullRequestBodyWriteIntent = {
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
    redrive: redriveValue,
    redriveRequired: row.redrive_required === 1,
    redriveDispatched: row.redrive_dispatched === 1,
  };
  if (result.redrive?.workflow === "pr-issue-link.yml" && result.redrive.inputs.cleanupUnmanaged === "true" && result.targetBlock !== null) throw new Error("正文写重调度清理目标无效");
  if (result.regionKind === "issue-links" && result.targetBlock !== null) issueLinksMetadataForIntent(result.targetBlock, result);
  return result;
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
    redrive?: PullRequestBodyRedrive;
  }): Promise<PullRequestBodyWriteIntent> {
    const repositoryId = positiveInteger(input.repositoryId, "repositoryId");
    const pullRequestNumber = positiveInteger(input.pullRequestNumber, "pullRequestNumber");
    const baseSha = requireSha(input.baseSha, "baseSha");
    const headSha = requireSha(input.headSha, "headSha");
    const issueGeneration = nonNegativeInteger(input.issueGeneration, "issueGeneration");
    if (!writeIdPattern.test(input.writeId)) throw new Error("writeId无效");
    if (!["managed-pr", "issue-links"].includes(input.regionKind)) throw new Error("regionKind无效");
    if (input.targetBlock !== null && Buffer.byteLength(input.targetBlock, "utf8") > 256 * 1024) throw new Error("目标受管块过大");
    if (input.regionKind === "managed-pr" && (input.targetBlock === null || managedRegionBlock(input.targetBlock, "managed-pr") !== input.targetBlock)) throw new Error("目标拉取请求受管块无效");
    if (input.regionKind === "issue-links" && input.targetBlock !== null) issueLinksMetadataForIntent(input.targetBlock, { repositoryId, pullRequestNumber, baseSha, headSha, issueGeneration });
    const beforeBodyDigest = requireDigest(input.beforeBodyDigest, "beforeBodyDigest");
    const outsideBodyDigest = requireDigest(input.outsideBodyDigest, "outsideBodyDigest");
    const targetBodyDigest = requireDigest(input.targetBodyDigest, "targetBodyDigest");
    const redrive = input.redrive ? normalizePullRequestBodyRedrive(input.redrive, { repositoryId, pullRequestNumber, regionKind: input.regionKind }) : null;
    if (redrive?.workflow === "pr-issue-link.yml" && redrive.inputs.cleanupUnmanaged === "true" && input.targetBlock !== null) throw new Error("正文写重调度清理目标无效");
    const values = [repositoryId, pullRequestNumber, input.writeId, input.regionKind, baseSha, headSha,
      issueGeneration, beforeBodyDigest, outsideBodyDigest, input.targetBlock, targetBodyDigest, redrive?.workflow ?? null, redrive ? JSON.stringify(redrive.inputs) : null, input.now, input.now, input.expiresAt];
    const result = await this.db.prepare(`INSERT INTO pull_request_body_write_intents
      (repository_id, pull_request_number, write_id, region_kind, base_sha, head_sha, issue_generation, before_body_digest, outside_body_digest, target_block, target_body_digest, redrive_workflow, redrive_inputs, status, compensation_generation, attempt_count, delivery_proven, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, 0, 0, ?, ?, ?)
      ON CONFLICT(repository_id, pull_request_number) DO UPDATE SET
        write_id=excluded.write_id, region_kind=excluded.region_kind, base_sha=excluded.base_sha, head_sha=excluded.head_sha,
        issue_generation=excluded.issue_generation, before_body_digest=excluded.before_body_digest, outside_body_digest=excluded.outside_body_digest,
        target_block=excluded.target_block, target_body_digest=excluded.target_body_digest, redrive_workflow=excluded.redrive_workflow, redrive_inputs=excluded.redrive_inputs, status='prepared', compensation_generation=0,
        attempt_count=0, delivery_proven=0, last_delivery_id=NULL, redrive_required=0, redrive_dispatched=0, created_at=excluded.created_at, updated_at=excluded.updated_at,
        expires_at=excluded.expires_at, confirmed_at=NULL, blocked_reason=NULL
      WHERE pull_request_body_write_intents.status IN ('confirmed','blocked') OR pull_request_body_write_intents.expires_at <= excluded.created_at`).bind(...values).run();
    if (affected(result) !== 1) {
      const current = await this.get(repositoryId, pullRequestNumber);
      if (current && ["prepared", "patched"].includes(current.status)
        && current.regionKind === input.regionKind && current.baseSha === baseSha && current.headSha === headSha
        && current.issueGeneration === issueGeneration && current.beforeBodyDigest === beforeBodyDigest
        && current.outsideBodyDigest === outsideBodyDigest && current.targetBlock === input.targetBlock && current.targetBodyDigest === targetBodyDigest
        && JSON.stringify(current.redrive) === JSON.stringify(redrive)) return current;
      await this.db.prepare(`UPDATE pull_request_body_write_intents SET redrive_workflow=?, redrive_inputs=?, redrive_required=1, redrive_dispatched=0, updated_at=?
        WHERE repository_id=? AND pull_request_number=? AND status IN ('prepared','patched','compensating')`)
        .bind(redrive?.workflow ?? null, redrive ? JSON.stringify(redrive.inputs) : null, input.now, repositoryId, pullRequestNumber).run();
      throw new Error("body-write-intent-conflict");
    }
    return (await this.get(repositoryId, pullRequestNumber))!;
  }

  async markPatched(repositoryId: number, pullRequestNumber: number, writeId: string, now: string): Promise<PullRequestBodyWriteIntent> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='patched', attempt_count=attempt_count+1,
      delivery_proven=0, last_delivery_id=NULL, updated_at=? WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status IN ('prepared','compensating') AND expires_at > ?`)
      .bind(now, repositoryId, pullRequestNumber, writeId, now).run();
    if (affected(result) !== 1) await this.blockExpiredIntent(repositoryId, pullRequestNumber, writeId, now);
    const current = await this.get(repositoryId, pullRequestNumber);
    if (affected(result) === 1) return current!;
    if (current?.writeId === writeId && ["patched", "confirmed"].includes(current.status)) return current;
    throw new Error("正文写意图状态冲突");
  }

  async proveDelivery(input: { repositoryId: number; pullRequestNumber: number; writeId: string; deliveryId: string; now: string }): Promise<PullRequestBodyWriteIntent> {
    if (!deliveryPattern.test(input.deliveryId)) throw new Error("deliveryId无效");
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET delivery_proven=1, last_delivery_id=?, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status='patched' AND expires_at > ?`)
      .bind(input.deliveryId, input.now, input.repositoryId, input.pullRequestNumber, input.writeId, input.now).run();
    if (affected(result) !== 1) await this.blockExpiredIntent(input.repositoryId, input.pullRequestNumber, input.writeId, input.now);
    if (affected(result) !== 1) throw new Error("正文写意图状态冲突");
    return (await this.get(input.repositoryId, input.pullRequestNumber))!;
  }

  async beginCompensation(input: { repositoryId: number; pullRequestNumber: number; writeId: string; deliveryId: string; beforeBodyDigest: string; outsideBodyDigest: string; targetBodyDigest: string; now: string }): Promise<PullRequestBodyWriteIntent> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='compensating', compensation_generation=compensation_generation+1,
      before_body_digest=?, outside_body_digest=?, target_body_digest=?, delivery_proven=0, last_delivery_id=?, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status IN ('patched','compensating') AND compensation_generation < 4 AND expires_at > ?`)
      .bind(requireDigest(input.beforeBodyDigest, "beforeBodyDigest"), requireDigest(input.outsideBodyDigest, "outsideBodyDigest"), requireDigest(input.targetBodyDigest, "targetBodyDigest"),
        input.deliveryId, input.now, input.repositoryId, input.pullRequestNumber, input.writeId, input.now).run();
    if (affected(result) !== 1) throw new Error("正文补偿上限或状态冲突");
    return (await this.get(input.repositoryId, input.pullRequestNumber))!;
  }

  async confirm(repositoryId: number, pullRequestNumber: number, writeId: string, now: string): Promise<PullRequestBodyWriteIntent> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='confirmed', confirmed_at=?, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status='patched' AND delivery_proven=1 AND expires_at > ?`)
      .bind(now, now, repositoryId, pullRequestNumber, writeId, now).run();
    if (affected(result) !== 1) await this.blockExpiredIntent(repositoryId, pullRequestNumber, writeId, now);
    if (affected(result) !== 1) throw new Error("正文写意图尚未得到交付证明");
    const current = await this.get(repositoryId, pullRequestNumber);
    if (!current || current.writeId !== writeId || current.status !== "confirmed") throw new Error("body-write-intent-conflict");
    return current;
  }

  private async blockExpiredIntent(repositoryId: number, pullRequestNumber: number, writeId: string, now: string): Promise<void> {
    await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='blocked', blocked_reason='recovery-window-expired', redrive_required=1, redrive_dispatched=0, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status IN ('prepared','patched','compensating') AND expires_at <= ?`)
      .bind(now, repositoryId, pullRequestNumber, writeId, now).run();
  }

  async block(repositoryId: number, pullRequestNumber: number, writeId: string, reason: string, now: string): Promise<PullRequestBodyWriteIntent> {
    if (!/^[a-z0-9-]{1,80}$/u.test(reason)) throw new Error("blockedReason无效");
    await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='blocked', blocked_reason=?, redrive_required=1, redrive_dispatched=0, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status NOT IN ('confirmed','blocked')`)
      .bind(reason, now, repositoryId, pullRequestNumber, writeId).run();
    return (await this.get(repositoryId, pullRequestNumber))!;
  }

  async claimDelivery(input: { deliveryId: string; repositoryId: number; pullRequestNumber: number; writeId: string; now: string }): Promise<string | null> {
    if (!deliveryPattern.test(input.deliveryId)) throw new Error("deliveryId无效");
    const claimedAt = new Date(input.now);
    if (!Number.isFinite(claimedAt.getTime())) throw new Error("交付处理时间无效");
    const staleBefore = new Date(claimedAt.getTime() - 5 * 60_000).toISOString();
    const claimId = randomUUID();
    const result = await this.db.prepare(`INSERT INTO pull_request_body_write_deliveries
      (delivery_id, repository_id, pull_request_number, write_id, claim_id, outcome, processed_at) VALUES (?, ?, ?, ?, ?, 'processing', ?)
      ON CONFLICT(delivery_id) DO UPDATE SET claim_id=excluded.claim_id, outcome='processing', processed_at=excluded.processed_at
      WHERE pull_request_body_write_deliveries.outcome='processing' AND pull_request_body_write_deliveries.processed_at <= ?
        AND pull_request_body_write_deliveries.repository_id=excluded.repository_id
        AND pull_request_body_write_deliveries.pull_request_number=excluded.pull_request_number
        AND pull_request_body_write_deliveries.write_id=excluded.write_id`)
      .bind(input.deliveryId, input.repositoryId, input.pullRequestNumber, input.writeId, claimId, input.now, staleBefore).run();
    return affected(result) === 1 ? claimId : null;
  }

  async completeDelivery(input: { deliveryId: string; claimId: string; outcome: "ignored" | "proven" | "compensated" | "blocked"; now: string }): Promise<void> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_deliveries SET outcome=?, processed_at=?
      WHERE delivery_id=? AND claim_id=? AND outcome='processing'`)
      .bind(input.outcome, input.now, input.deliveryId, input.claimId).run();
    if (affected(result) !== 1) throw new Error("正文写交付声明已经失效");
  }

  async listRecoverable(now: string, limit = 20): Promise<readonly PullRequestBodyWriteIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("恢复批量无效");
    const rows = await this.db.prepare(`SELECT * FROM pull_request_body_write_intents
      WHERE status IN ('prepared','patched','compensating') AND expires_at > ? ORDER BY updated_at, repository_id, pull_request_number LIMIT ?`)
      .bind(now, limit).all<IntentRow>();
    return rows.results.map((row) => intent(row)!);
  }

  async requestRedrive(repositoryId: number, pullRequestNumber: number, writeId: string, now: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET redrive_required=1, redrive_dispatched=0, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=?`)
      .bind(now, repositoryId, pullRequestNumber, writeId).run();
    if (affected(result) !== 1) throw new Error("正文写意图不能重新调度");
  }

  async listPendingRedrives(limit = 20, retryBefore = ""): Promise<readonly PullRequestBodyWriteIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("重新调度批量无效");
    if (retryBefore && !Number.isFinite(new Date(retryBefore).getTime())) throw new Error("重新调度重试时间无效");
    const rows = await this.db.prepare(`SELECT * FROM pull_request_body_write_intents
      WHERE status IN ('confirmed','blocked') AND redrive_required=1 AND (redrive_dispatched=0 OR updated_at <= ?)
      ORDER BY updated_at, repository_id, pull_request_number LIMIT ?`).bind(retryBefore, limit).all<IntentRow>();
    return rows.results.map((row) => intent(row)!);
  }

  async claimRedrive(repositoryId: number, pullRequestNumber: number, writeId: string, now: string, retryBefore: string): Promise<boolean> {
    if (!Number.isFinite(new Date(now).getTime()) || !Number.isFinite(new Date(retryBefore).getTime())) throw new Error("重新调度声明时间无效");
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET redrive_dispatched=1, updated_at=?
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status IN ('confirmed','blocked') AND redrive_required=1
      AND (redrive_dispatched=0 OR updated_at <= ?)`)
      .bind(now, repositoryId, pullRequestNumber, writeId, retryBefore).run();
    return affected(result) === 1;
  }

  async releaseRedrive(repositoryId: number, pullRequestNumber: number, writeId: string, claimedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET redrive_dispatched=0
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status IN ('confirmed','blocked') AND redrive_required=1
      AND redrive_dispatched=1 AND updated_at=?`)
      .bind(repositoryId, pullRequestNumber, writeId, claimedAt).run();
    return affected(result) === 1;
  }

  async abandonClaimedRedrive(repositoryId: number, pullRequestNumber: number, writeId: string, claimedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET redrive_required=0
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status IN ('confirmed','blocked') AND redrive_required=1
      AND redrive_dispatched=1 AND updated_at=?`)
      .bind(repositoryId, pullRequestNumber, writeId, claimedAt).run();
    return affected(result) === 1;
  }

  async completeRedrive(repositoryId: number, pullRequestNumber: number, writeId: string): Promise<PullRequestBodyWriteIntent> {
    const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET redrive_required=0
      WHERE repository_id=? AND pull_request_number=? AND write_id=? AND status IN ('confirmed','blocked') AND redrive_required=1 AND redrive_dispatched=1`)
      .bind(repositoryId, pullRequestNumber, writeId).run();
    const state = await this.db.prepare(`SELECT write_id, status, redrive_required FROM pull_request_body_write_intents
      WHERE repository_id=? AND pull_request_number=?`).bind(repositoryId, pullRequestNumber).first<{ write_id: string; status: string; redrive_required: number }>();
    const current = await this.get(repositoryId, pullRequestNumber);
    if (!state || !current || state.write_id !== writeId || current.writeId !== writeId || !["confirmed", "blocked"].includes(state.status) || state.redrive_required !== 0) {
      throw new Error("正文写重调度不能确认完成");
    }
    if (affected(result) !== 1 && current.redriveRequired) throw new Error("正文写重调度不能确认完成");
    return current;
  }

  async blockExpired(now: string, limit = 20): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("过期批量无效");
    const rows = await this.db.prepare(`SELECT repository_id, pull_request_number, write_id FROM pull_request_body_write_intents
      WHERE status IN ('prepared','patched','compensating') AND expires_at <= ? ORDER BY expires_at, repository_id, pull_request_number LIMIT ?`)
      .bind(now, limit).all<{ repository_id: number; pull_request_number: number; write_id: string }>();
    let blocked = 0;
    for (const row of rows.results) {
      const result = await this.db.prepare(`UPDATE pull_request_body_write_intents SET status='blocked', blocked_reason='recovery-window-expired', redrive_required=1, redrive_dispatched=0, updated_at=?
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
  const claimId = await input.store.claimDelivery({ deliveryId: input.deliveryId, repositoryId, pullRequestNumber, writeId: current.writeId, now: input.now });
  if (!claimId) return "duplicate";
  const record = async (outcome: "ignored" | "proven" | "compensated" | "blocked") => {
    await input.store.completeDelivery({ deliveryId: input.deliveryId, claimId, outcome, now: input.now });
    return outcome;
  };
  if (!["prepared", "patched", "compensating"].includes(current.status)) return record("ignored");
  if (!Object.prototype.hasOwnProperty.call(input.payload?.changes ?? {}, "body")) return record("ignored");
  const after = input.payload?.pull_request?.body;
  if (typeof after !== "string" || Buffer.byteLength(after, "utf8") > 1024 * 1024) return record("ignored");
  if (Number(input.payload?.sender?.id) !== 301115370) {
    await input.store.block(repositoryId, pullRequestNumber, current.writeId, "non-steward-body-edit", input.now);
    return record("ignored");
  }
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
    let compensationWritten = false;
    try {
      const liveBeforeCompensation = await input.client.getPullRequest(owner, repo, pullRequestNumber);
      if (liveBeforeCompensation?.head?.sha !== current.headSha || liveBeforeCompensation?.base?.sha !== current.baseSha) throw new Error("补偿恢复前提交已经漂移");
      const liveBody = String(liveBeforeCompensation?.body ?? "");
      let compensatedBody: string;
      if (current.lastDeliveryId === input.deliveryId) {
        compensatedBody = applyManagedRegion(before, current.regionKind, current.targetBlock);
        if (pullRequestBodyDigest(compensatedBody) !== current.targetBodyDigest) throw new Error("补偿目标正文摘要不一致");
        if (liveBody === compensatedBody) compensationWritten = true;
        else if (liveBody !== after) throw new Error("补偿恢复前正文已经漂移");
      } else {
        if (liveBody !== after) throw new Error("补偿恢复前正文已经漂移");
        compensatedBody = applyManagedRegion(after, current.regionKind, current.targetBlock);
        current = await input.store.beginCompensation({
          repositoryId,
          pullRequestNumber,
          writeId: current.writeId,
          deliveryId: input.deliveryId,
          beforeBodyDigest: afterDigest,
          outsideBodyDigest: bodyOutsideManagedRegionDigest(compensatedBody, current.regionKind),
          targetBodyDigest: pullRequestBodyDigest(compensatedBody),
          now: input.now,
        });
      }
      if (!compensationWritten) {
        const written = await input.client.updatePullRequest(owner, repo, pullRequestNumber, { body: compensatedBody });
        if (written?.head?.sha !== current.headSha || written?.base?.sha !== current.baseSha || String(written?.body ?? "") !== compensatedBody) throw new Error("补偿恢复写入响应不一致");
        compensationWritten = true;
      }
      await input.store.markPatched(repositoryId, pullRequestNumber, current.writeId, input.now);
      return record("compensated");
    } catch {
      if (compensationWritten) return record("compensated");
      await input.store.block(repositoryId, pullRequestNumber, current.writeId, "compensation-recovery-failed", input.now);
      return record("blocked");
    }
  }
  if (afterDigest !== current.targetBodyDigest) {
    await input.store.block(repositoryId, pullRequestNumber, current.writeId, "target-body-drifted", input.now);
    return record("ignored");
  }
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
  let compensatedBody: string;
  try {
    compensatedBody = applyManagedRegion(before, current.regionKind, current.targetBlock);
  } catch {
    await input.store.block(repositoryId, pullRequestNumber, current.writeId, "compensation-input-invalid", input.now);
    return record("blocked");
  }
  let compensated: PullRequestBodyWriteIntent;
  try {
    compensated = await input.store.beginCompensation({
      repositoryId,
      pullRequestNumber,
      writeId: current.writeId,
      deliveryId: input.deliveryId,
      beforeBodyDigest: pullRequestBodyDigest(after),
      outsideBodyDigest: bodyOutsideManagedRegionDigest(compensatedBody, current.regionKind),
      targetBodyDigest: pullRequestBodyDigest(compensatedBody),
      now: input.now,
    });
  } catch {
    const latest = await input.store.get(repositoryId, pullRequestNumber);
    if (latest?.writeId === current.writeId && ["compensating", "patched", "confirmed"].includes(latest.status)) return record("ignored");
    await input.store.block(repositoryId, pullRequestNumber, current.writeId, "compensation-failed", input.now);
    return record("blocked");
  }
  let compensationWritten = false;
  try {
    const written = await input.client.updatePullRequest(owner, repo, pullRequestNumber, { body: compensatedBody });
    if (written?.head?.sha !== current.headSha || written?.base?.sha !== current.baseSha || String(written?.body ?? "") !== compensatedBody) throw new Error("补偿正文写入响应不一致");
    compensationWritten = true;
    await input.store.markPatched(repositoryId, pullRequestNumber, compensated.writeId, input.now);
    return record("compensated");
  } catch {
    if (compensationWritten) return record("compensated");
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
    if (current.targetBlock !== null) {
      const state = await input.store.issueGeneration(repositoryId);
      if (state !== current.issueGeneration) return input.store.block(repositoryId, input.pullRequestNumber, input.writeId, "issue-generation-drifted", input.now);
    }
    const metadata = current.targetBlock ? issueLinksMetadataForIntent(current.targetBlock, current) : null;
    const desired = metadata ? metadata.issueNumbers.map((number) => ({ repositoryId, number })) : [];
    const sets = await input.client.listPullRequestClosingIssueSets(owner, repo, input.pullRequestNumber, repositoryId);
    if (!verifyIssueLinkConvergence(desired, sets, repositoryId).converged) return current;
  }
  return input.store.confirm(repositoryId, input.pullRequestNumber, input.writeId, input.now);
}
