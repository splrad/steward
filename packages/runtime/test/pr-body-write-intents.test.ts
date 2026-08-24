import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { extractManagedPullRequestBlock, renderManagedBody, replaceManagedPullRequestBlock } from "../../core/src/automation.js";
import { removeIssueLinksBlock, renderIssueLinksBlock, upsertIssueLinksBlock } from "../../core/src/issues.js";
import {
  bodyOutsideManagedRegionDigest,
  confirmPullRequestBodyWriteIntent,
  processPullRequestBodyEditedDelivery,
  pullRequestBodyDigest,
  PullRequestBodyWriteIntentStore,
} from "../src/pr-body-write-intents.js";

class SqliteD1Statement {
  constructor(private readonly database: DatabaseSync, private readonly sql: string, private readonly values: readonly SQLInputValue[] = []) {}
  bind(...values: unknown[]): SqliteD1Statement { return new SqliteD1Statement(this.database, this.sql, values as SQLInputValue[]); }
  async first<T>(): Promise<T | null> { return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async all<T>(): Promise<D1Result<T>> { return { success: true, results: this.database.prepare(this.sql).all(...this.values) as T[], meta: {} as D1Meta }; }
  async run<T>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } as D1Meta };
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(":memory:");
  constructor() {
    for (const migration of ["0001_issue_snapshots.sql", "0002_issue_snapshot_tombstones.sql", "0003_issue_snapshot_reconciliation.sql", "0004_issue_snapshot_state_revision.sql", "0005_issue_snapshot_reconciliation_revision.sql", "0006_pull_request_body_write_intents.sql", "0007_pull_request_body_write_redrive.sql"]) {
      this.database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
  }
  prepare(sql: string): D1PreparedStatement { return new SqliteD1Statement(this.database, sql) as unknown as D1PreparedStatement; }
  binding(): D1Database { return this as unknown as D1Database; }
}

const repositoryId = 1296724484;
const pullRequestNumber = 42;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const now = "2026-08-22T00:00:00.000Z";
const expiresAt = "2026-08-22T00:10:00.000Z";
const repository = { id: repositoryId, full_name: "splrad/steward" };

function managedBlock(summary: string): string {
  const body = renderManagedBody({
    generated: { type: "chore", scope: "test", title: "测试", summary, motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] },
    templateBody: "<!-- workflow:managed-pr:start -->\n<!-- workflow:managed-pr:end -->\n",
    actor: "splrad-steward[bot]",
    contributors: [],
    context: "test",
  });
  return extractManagedPullRequestBlock(body).block;
}

function body(outside: string, block: string): string {
  return `${outside}\n${block}\n尾部\n`;
}

async function prepared(store: PullRequestBodyWriteIntentStore, before: string, targetBlock: string, writeId = "11111111-1111-4111-8111-111111111111") {
  const target = body("人工前言", targetBlock);
  await store.prepare({
    repositoryId,
    pullRequestNumber,
    writeId,
    regionKind: "managed-pr",
    baseSha,
    headSha,
    issueGeneration: 0,
    beforeBodyDigest: pullRequestBodyDigest(before),
    outsideBodyDigest: bodyOutsideManagedRegionDigest(before, "managed-pr"),
    targetBlock,
    targetBodyDigest: pullRequestBodyDigest(target),
    now,
    expiresAt,
  });
  return { target, writeId };
}

function payload(before: string, after: string, deliverySender = 301115370): any {
  return {
    action: "edited",
    repository,
    sender: { id: deliverySender },
    changes: { body: { from: before } },
    pull_request: { number: pullRequestNumber, body: after, head: { sha: headSha }, base: { sha: baseSha } },
  };
}

describe("拉取请求正文持久补偿协议", () => {
  it("过期意图不能继续推进，并进入阻断重调度状态", async () => {
    const expiredNow = "2026-08-22T00:11:00.000Z";

    const markDatabase = new SqliteD1();
    const markStore = new PullRequestBodyWriteIntentStore(markDatabase.binding());
    const markBefore = body("人工前言", managedBlock("旧摘要"));
    const { writeId: markWriteId } = await prepared(markStore, markBefore, managedBlock("新摘要"));
    await expect(markStore.markPatched(repositoryId, pullRequestNumber, markWriteId, expiredNow)).rejects.toThrow("状态冲突");
    expect(await markStore.get(repositoryId, pullRequestNumber)).toEqual(expect.objectContaining({
      status: "blocked", blockedReason: "recovery-window-expired", redriveRequired: true,
    }));

    const proveDatabase = new SqliteD1();
    const proveStore = new PullRequestBodyWriteIntentStore(proveDatabase.binding());
    const proveBefore = body("人工前言", managedBlock("旧摘要"));
    const { writeId: proveWriteId } = await prepared(proveStore, proveBefore, managedBlock("新摘要"));
    await proveStore.markPatched(repositoryId, pullRequestNumber, proveWriteId, now);
    await expect(proveStore.proveDelivery({ repositoryId, pullRequestNumber, writeId: proveWriteId, deliveryId: "delivery-expired", now: expiredNow })).rejects.toThrow("状态冲突");
    expect(await proveStore.get(repositoryId, pullRequestNumber)).toEqual(expect.objectContaining({
      status: "blocked", blockedReason: "recovery-window-expired", redriveRequired: true,
    }));

    const confirmDatabase = new SqliteD1();
    const confirmStore = new PullRequestBodyWriteIntentStore(confirmDatabase.binding());
    const confirmBefore = body("人工前言", managedBlock("旧摘要"));
    const { writeId: confirmWriteId } = await prepared(confirmStore, confirmBefore, managedBlock("新摘要"));
    await confirmStore.markPatched(repositoryId, pullRequestNumber, confirmWriteId, now);
    await confirmStore.proveDelivery({ repositoryId, pullRequestNumber, writeId: confirmWriteId, deliveryId: "delivery-before-expiry", now });
    await expect(confirmStore.confirm(repositoryId, pullRequestNumber, confirmWriteId, expiredNow)).rejects.toThrow("交付证明");
    expect(await confirmStore.get(repositoryId, pullRequestNumber)).toEqual(expect.objectContaining({
      status: "blocked", blockedReason: "recovery-window-expired", redriveRequired: true,
    }));
  });

  it("只有edited前值证明匹配后才确认写意图", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const targetBlock = managedBlock("新摘要");
    const { target, writeId } = await prepared(store, before, targetBlock);
    let live = target;
    const client = {
      getPullRequest: async () => ({ number: pullRequestNumber, body: live, head: { sha: headSha }, base: { sha: baseSha } }),
      updatePullRequest: async (_owner: string, _repo: string, _number: number, patch: any) => ({ number: pullRequestNumber, body: (live = patch.body), head: { sha: headSha }, base: { sha: baseSha } }),
    } as any;
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(before, target), deliveryId: "delivery-1", now })).toBe("proven");
    expect((await store.get(repositoryId, pullRequestNumber))?.status).toBe("patched");
    expect((await store.get(repositoryId, pullRequestNumber))?.attemptCount).toBe(1);
    expect((await store.get(repositoryId, pullRequestNumber))?.deliveryProven).toBe(true);
    expect((await confirmPullRequestBodyWriteIntent({ store, client, repository, pullRequestNumber, writeId, now })).status).toBe("confirmed");
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(before, target), deliveryId: "delivery-1", now })).toBe("duplicate");
  });

  it("同一交付并发到达时只有一个处理器取得原子声明", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const { target } = await prepared(store, before, managedBlock("新摘要"));
    await store.markPatched(repositoryId, pullRequestNumber, "11111111-1111-4111-8111-111111111111", now);
    let reads = 0;
    const client = { getPullRequest: async () => { reads += 1; await Promise.resolve(); return { number: pullRequestNumber, body: target, head: { sha: headSha }, base: { sha: baseSha } }; } } as any;
    const outcomes = await Promise.all([
      processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(before, target), deliveryId: "delivery-concurrent", now }),
      processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(before, target), deliveryId: "delivery-concurrent", now }),
    ]);
    expect(outcomes.sort()).toEqual(["duplicate", "proven"]);
    expect(reads).toBe(1);
  });

  it("过期交付声明只能由原写意图重新取得", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const originalWriteId = "11111111-1111-4111-8111-111111111111";
    const claimed = await store.claimDelivery({ deliveryId: "delivery-stale", repositoryId, pullRequestNumber, writeId: originalWriteId, now });
    expect(claimed).not.toBeNull();

    const reclaimedAt = "2026-08-22T00:06:00.000Z";
    expect(await store.claimDelivery({
      deliveryId: "delivery-stale",
      repositoryId,
      pullRequestNumber,
      writeId: "22222222-2222-4222-8222-222222222222",
      now: reclaimedAt,
    })).toBeNull();
    expect(await store.claimDelivery({ deliveryId: "delivery-stale", repositoryId, pullRequestNumber, writeId: originalWriteId, now: reclaimedAt })).not.toBeNull();
  });

  it("确认后的读取漂移到新写意图时拒绝返回新状态", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const { target, writeId } = await prepared(store, before, managedBlock("新摘要"));
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    await store.proveDelivery({ repositoryId, pullRequestNumber, writeId, deliveryId: "delivery-confirm-race", now });
    const originalGet = store.get.bind(store);
    let reads = 0;
    store.get = async (...args) => {
      const current = await originalGet(...args);
      reads += 1;
      return reads === 2 && current ? { ...current, writeId: "22222222-2222-4222-8222-222222222222" } : current;
    };
    const client = { getPullRequest: async () => ({ number: pullRequestNumber, body: target, head: { sha: headSha }, base: { sha: baseSha } }) } as any;

    await expect(confirmPullRequestBodyWriteIntent({ store, client, repository, pullRequestNumber, writeId, now })).rejects.toThrow("body-write-intent-conflict");
  });

  it("机器人只改标题时忽略交付并保留活动意图", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const { target, writeId } = await prepared(store, before, managedBlock("新摘要"));
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    const titleOnly = payload(before, target); titleOnly.changes = { title: { from: "旧标题" } };
    expect(await processPullRequestBodyEditedDelivery({ store, client: {} as any, repository, payload: titleOnly, deliveryId: "delivery-title-only", now })).toBe("ignored");
    expect((await store.get(repositoryId, pullRequestNumber))?.status).toBe("patched");
  });

  it("议题正文意图确认会校验GitHub关闭议题集合", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("摘要"));
    const targetBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber, baseSha, headSha, generation: 0, analysisInputDigest: "c".repeat(64) }, [{ repositoryId, number: 7 }]);
    const target = upsertIssueLinksBlock(before, targetBlock);
    const writeId = "77777777-7777-4777-8777-777777777777";
    await store.prepare({
      repositoryId,
      pullRequestNumber,
      writeId,
      regionKind: "issue-links",
      baseSha,
      headSha,
      issueGeneration: 0,
      beforeBodyDigest: pullRequestBodyDigest(before),
      outsideBodyDigest: bodyOutsideManagedRegionDigest(before, "issue-links"),
      targetBlock,
      targetBodyDigest: pullRequestBodyDigest(target),
      now,
      expiresAt,
    });
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    await store.proveDelivery({ repositoryId, pullRequestNumber, writeId, deliveryId: "delivery-issue-links", now });
    const reference = { repositoryId, number: 7 };
    const client = {
      getPullRequest: async () => ({ number: pullRequestNumber, body: target, head: { sha: headSha }, base: { sha: baseSha } }),
      listPullRequestClosingIssueSets: async () => ({ all: [reference], manual: [], automatic: [reference] }),
    } as any;

    expect((await confirmPullRequestBodyWriteIntent({ store, client, repository, pullRequestNumber, writeId, now })).status).toBe("confirmed");
  });

  it("议题正文意图把子块元数据绑定到当前写入上下文", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("摘要"));
    const metadataCases = [
      { repositoryId: repositoryId + 1, pullRequestNumber, baseSha, headSha, generation: 0 },
      { repositoryId, pullRequestNumber: pullRequestNumber + 1, baseSha, headSha, generation: 0 },
      { repositoryId, pullRequestNumber, baseSha: "c".repeat(40), headSha, generation: 0 },
      { repositoryId, pullRequestNumber, baseSha, headSha: "d".repeat(40), generation: 0 },
      { repositoryId, pullRequestNumber, baseSha, headSha, generation: 1 },
    ];
    for (const metadata of metadataCases) {
      const targetBlock = renderIssueLinksBlock({ ...metadata, analysisInputDigest: "e".repeat(64) }, [{ repositoryId: metadata.repositoryId, number: 7 }]);
      await expect(store.prepare({
        repositoryId,
        pullRequestNumber,
        writeId: "99999999-9999-4999-8999-999999999999",
        regionKind: "issue-links",
        baseSha,
        headSha,
        issueGeneration: 0,
        beforeBodyDigest: pullRequestBodyDigest(before),
        outsideBodyDigest: bodyOutsideManagedRegionDigest(before, "issue-links"),
        targetBlock,
        targetBodyDigest: pullRequestBodyDigest(upsertIssueLinksBlock(before, targetBlock)),
        now,
        expiresAt,
      })).rejects.toThrow("上下文不匹配");
    }

    const targetBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber, baseSha, headSha, generation: 0, analysisInputDigest: "e".repeat(64) }, [{ repositoryId, number: 7 }]);
    await store.prepare({ repositoryId, pullRequestNumber, writeId: "99999999-9999-4999-8999-999999999999", regionKind: "issue-links", baseSha, headSha, issueGeneration: 0,
      beforeBodyDigest: pullRequestBodyDigest(before), outsideBodyDigest: bodyOutsideManagedRegionDigest(before, "issue-links"), targetBlock,
      targetBodyDigest: pullRequestBodyDigest(upsertIssueLinksBlock(before, targetBlock)), now, expiresAt });
    const driftedBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber, baseSha, headSha: "d".repeat(40), generation: 0, analysisInputDigest: "e".repeat(64) }, [{ repositoryId, number: 7 }]);
    database.database.prepare("UPDATE pull_request_body_write_intents SET target_block = ? WHERE repository_id = ? AND pull_request_number = ?").run(driftedBlock, repositoryId, pullRequestNumber);
    await expect(store.get(repositoryId, pullRequestNumber)).rejects.toThrow("上下文不匹配");
  });

  it("议题正文意图从零代开始也会阻断代次漂移", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("摘要"));
    const targetBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber, baseSha, headSha, generation: 0, analysisInputDigest: "c".repeat(64) }, [{ repositoryId, number: 7 }]);
    const target = upsertIssueLinksBlock(before, targetBlock);
    const writeId = "88888888-8888-4888-8888-888888888888";
    await store.prepare({ repositoryId, pullRequestNumber, writeId, regionKind: "issue-links", baseSha, headSha, issueGeneration: 0,
      beforeBodyDigest: pullRequestBodyDigest(before), outsideBodyDigest: bodyOutsideManagedRegionDigest(before, "issue-links"), targetBlock, targetBodyDigest: pullRequestBodyDigest(target), now, expiresAt });
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    await store.proveDelivery({ repositoryId, pullRequestNumber, writeId, deliveryId: "delivery-generation-zero", now });
    database.database.prepare("INSERT INTO issue_snapshot_repositories (repository_id, generation, open_set_digest, sync_state, updated_at) VALUES (?, 1, ?, 'ready', ?)")
      .run(repositoryId, "d".repeat(64), now);
    const client = { getPullRequest: async () => ({ number: pullRequestNumber, body: target, head: { sha: headSha }, base: { sha: baseSha } }) } as any;
    expect((await confirmPullRequestBodyWriteIntent({ store, client, repository, pullRequestNumber, writeId, now })).blockedReason).toBe("issue-generation-drifted");
  });

  it("删除议题受管块不因快照代次漂移而阻断", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const issueBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber, baseSha, headSha, generation: 1, analysisInputDigest: "c".repeat(64) }, [{ repositoryId, number: 7 }]);
    const before = upsertIssueLinksBlock(body("人工前言", managedBlock("摘要")), issueBlock);
    const target = removeIssueLinksBlock(before);
    const writeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    database.database.prepare("INSERT INTO issue_snapshot_repositories (repository_id, generation, open_set_digest, sync_state, updated_at) VALUES (?, 1, ?, 'ready', ?)")
      .run(repositoryId, "d".repeat(64), now);
    await store.prepare({ repositoryId, pullRequestNumber, writeId, regionKind: "issue-links", baseSha, headSha, issueGeneration: 1,
      beforeBodyDigest: pullRequestBodyDigest(before), outsideBodyDigest: bodyOutsideManagedRegionDigest(before, "issue-links"), targetBlock: null,
      targetBodyDigest: pullRequestBodyDigest(target), now, expiresAt });
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    await store.proveDelivery({ repositoryId, pullRequestNumber, writeId, deliveryId: "delivery-remove-generation", now });
    database.database.prepare("UPDATE issue_snapshot_repositories SET generation = 2 WHERE repository_id = ?").run(repositoryId);
    const client = {
      getPullRequest: async () => ({ number: pullRequestNumber, body: target, head: { sha: headSha }, base: { sha: baseSha } }),
      listPullRequestClosingIssueSets: async () => ({ all: [], manual: [], automatic: [] }),
    } as any;
    expect((await confirmPullRequestBodyWriteIntent({ store, client, repository, pullRequestNumber, writeId, now })).status).toBe("confirmed");
  });

  it("GitHub关闭议题集合暂未收敛时保持patched供固定窗口重试", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("摘要"));
    const targetBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber, baseSha, headSha, generation: 0, analysisInputDigest: "c".repeat(64) }, [{ repositoryId, number: 7 }]);
    const target = upsertIssueLinksBlock(before, targetBlock);
    const writeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await store.prepare({ repositoryId, pullRequestNumber, writeId, regionKind: "issue-links", baseSha, headSha, issueGeneration: 0,
      beforeBodyDigest: pullRequestBodyDigest(before), outsideBodyDigest: bodyOutsideManagedRegionDigest(before, "issue-links"), targetBlock,
      targetBodyDigest: pullRequestBodyDigest(target), now, expiresAt });
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    await store.proveDelivery({ repositoryId, pullRequestNumber, writeId, deliveryId: "delivery-not-converged", now });
    const client = {
      getPullRequest: async () => ({ number: pullRequestNumber, body: target, head: { sha: headSha }, base: { sha: baseSha } }),
      listPullRequestClosingIssueSets: async () => ({ all: [], manual: [], automatic: [] }),
    } as any;
    expect((await confirmPullRequestBodyWriteIntent({ store, client, repository, pullRequestNumber, writeId, now })).status).toBe("patched");
  });

  it("最终GET后发生块外人工编辑时自动补偿并逐字保留", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const original = body("人工前言", managedBlock("旧摘要"));
    const humanBeforePatch = body("人工前言\n人工追加一行", managedBlock("旧摘要"));
    const targetBlock = managedBlock("新摘要");
    const { target: overwritten, writeId } = await prepared(store, original, targetBlock);
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    let live = overwritten;
    const writes: string[] = [];
    const client = {
      getPullRequest: async () => ({ number: pullRequestNumber, body: live, head: { sha: headSha }, base: { sha: baseSha } }),
      updatePullRequest: async (_owner: string, _repo: string, _number: number, patch: any) => {
        live = patch.body; writes.push(live);
        return { number: pullRequestNumber, body: live, head: { sha: headSha }, base: { sha: baseSha } };
      },
    } as any;
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(humanBeforePatch, overwritten), deliveryId: "delivery-race-1", now })).toBe("compensated");
    expect(writes).toHaveLength(1);
    expect(live).toContain("人工追加一行");
    expect(live).toContain("新摘要");
    expect(live).not.toContain("旧摘要");
    expect((await store.get(repositoryId, pullRequestNumber))?.compensationGeneration).toBe(1);
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(overwritten, live), deliveryId: "delivery-race-2", now })).toBe("proven");
    expect((await confirmPullRequestBodyWriteIntent({ store, client, repository, pullRequestNumber, writeId, now })).status).toBe("confirmed");
  });

  it("补偿状态持久化后崩溃可由同一交付恢复PATCH", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const original = body("人工前言", managedBlock("旧摘要"));
    const humanBeforePatch = body("人工前言\n人工追加一行", managedBlock("旧摘要"));
    const targetBlock = managedBlock("新摘要");
    const { target: overwritten, writeId } = await prepared(store, original, targetBlock);
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    const compensatedBody = replaceManagedPullRequestBlock(humanBeforePatch, targetBlock);
    await store.beginCompensation({ repositoryId, pullRequestNumber, writeId, deliveryId: "delivery-crash", beforeBodyDigest: pullRequestBodyDigest(overwritten), outsideBodyDigest: bodyOutsideManagedRegionDigest(compensatedBody, "managed-pr"), targetBodyDigest: pullRequestBodyDigest(compensatedBody), now });
    let live = overwritten;
    const client = {
      getPullRequest: async () => ({ number: pullRequestNumber, body: live, head: { sha: headSha }, base: { sha: baseSha } }),
      updatePullRequest: async (_owner: string, _repo: string, _number: number, patch: any) => ({ number: pullRequestNumber, body: (live = patch.body), head: { sha: headSha }, base: { sha: baseSha } }),
    } as any;
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(humanBeforePatch, overwritten), deliveryId: "delivery-crash", now })).toBe("compensated");
    expect(live).toBe(compensatedBody);
    expect((await store.get(repositoryId, pullRequestNumber))?.status).toBe("patched");
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(overwritten, compensatedBody), deliveryId: "delivery-crash-confirm", now })).toBe("proven");
  });

  it("补偿PATCH成功但状态回写失败时保留可恢复状态而不误阻断", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const original = body("人工前言", managedBlock("旧摘要"));
    const humanBeforePatch = body("人工前言\n人工追加一行", managedBlock("旧摘要"));
    const { target: overwritten, writeId } = await prepared(store, original, managedBlock("新摘要"));
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    let live = overwritten;
    const client = {
      getPullRequest: async () => ({ number: pullRequestNumber, body: live, head: { sha: headSha }, base: { sha: baseSha } }),
      updatePullRequest: async (_owner: string, _repo: string, _number: number, patch: any) => ({ number: pullRequestNumber, body: (live = patch.body), head: { sha: headSha }, base: { sha: baseSha } }),
    } as any;
    store.markPatched = async () => { throw new Error("d1 unavailable"); };
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(humanBeforePatch, overwritten), deliveryId: "delivery-mark-failed", now })).toBe("compensated");
    expect((await store.get(repositoryId, pullRequestNumber))?.status).toBe("compensating");
    expect(live).toContain("人工追加一行");
  });

  it("补偿期间到达新交付时以最新after正文为基底保留人工编辑", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const original = body("人工前言", managedBlock("旧摘要"));
    const humanBeforePatch = body("人工前言\n人工追加一行", managedBlock("旧摘要"));
    const targetBlock = managedBlock("新摘要");
    const { target: overwritten, writeId } = await prepared(store, original, targetBlock);
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    const firstCompensation = replaceManagedPullRequestBlock(humanBeforePatch, targetBlock);
    await store.beginCompensation({ repositoryId, pullRequestNumber, writeId, deliveryId: "delivery-first-compensation",
      beforeBodyDigest: pullRequestBodyDigest(overwritten), outsideBodyDigest: bodyOutsideManagedRegionDigest(firstCompensation, "managed-pr"),
      targetBodyDigest: pullRequestBodyDigest(firstCompensation), now });
    const newerAfter = body("人工前言\n人工追加一行\n最新人工编辑", targetBlock);
    let live = newerAfter;
    const client = {
      getPullRequest: async () => ({ number: pullRequestNumber, body: live, head: { sha: headSha }, base: { sha: baseSha } }),
      updatePullRequest: async (_owner: string, _repo: string, _number: number, patch: any) => ({ number: pullRequestNumber, body: (live = patch.body), head: { sha: headSha }, base: { sha: baseSha } }),
    } as any;
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(firstCompensation, newerAfter), deliveryId: "delivery-newer-edit", now })).toBe("compensated");
    expect(live).toContain("最新人工编辑");
    expect(live).toContain("新摘要");
    expect((await store.get(repositoryId, pullRequestNumber))?.compensationGeneration).toBe(2);
  });

  it("补偿输入标记损坏时阻断并完整记录交付结果", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const { target, writeId } = await prepared(store, before, managedBlock("新摘要"));
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    const malformedBefore = "人工前言\n<!-- workflow:managed-pr:start -->\n损坏";
    const client = { getPullRequest: async () => ({ number: pullRequestNumber, body: target, head: { sha: headSha }, base: { sha: baseSha } }) } as any;
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(malformedBefore, target), deliveryId: "delivery-malformed-compensation", now })).toBe("blocked");
    expect((await store.get(repositoryId, pullRequestNumber))?.blockedReason).toBe("compensation-input-invalid");
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(malformedBefore, target), deliveryId: "delivery-malformed-compensation", now })).toBe("duplicate");
  });

  it("证据缺失、提交漂移和旧意图交付都失败关闭或忽略", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const targetBlock = managedBlock("新摘要");
    const { target, writeId } = await prepared(store, before, targetBlock);
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    const client = { getPullRequest: async () => ({ number: pullRequestNumber, body: target, head: { sha: headSha }, base: { sha: baseSha } }) } as any;
    const missing = payload(before, target); delete missing.changes.body.from;
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: missing, deliveryId: "delivery-missing", now })).toBe("blocked");
    expect((await store.get(repositoryId, pullRequestNumber))?.blockedReason).toBe("edited-evidence-unavailable");

    const newer = await prepared(store, before, managedBlock("更新摘要"), "22222222-2222-4222-8222-222222222222");
    await store.markPatched(repositoryId, pullRequestNumber, newer.writeId, now);
    expect(await processPullRequestBodyEditedDelivery({ store, client, repository, payload: payload(before, target), deliveryId: "delivery-old", now })).toBe("ignored");
    expect((await store.get(repositoryId, pullRequestNumber))?.writeId).toBe(newer.writeId);
  });

  it("同一PR的活动意图保留胜出写入并重调度失败方", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const winnerRedrive = { workflow: "pr-automation.yml", inputs: { deliveryId: "delivery-winner", repositoryId: String(repositoryId), sourceRef: "refs/heads/feature/test", eventAfterSha: headSha, sourceActorId: "44151430", sourceActorLogin: "axiomoth", policySha: "a".repeat(40) } } as const;
    const winnerTargetBlock = managedBlock("新摘要");
    const winnerTarget = body("人工前言", winnerTargetBlock);
    await store.prepare({ repositoryId, pullRequestNumber, writeId: "11111111-1111-4111-8111-111111111111", regionKind: "managed-pr", baseSha, headSha, issueGeneration: 0,
      beforeBodyDigest: pullRequestBodyDigest(before), outsideBodyDigest: bodyOutsideManagedRegionDigest(before, "managed-pr"), targetBlock: winnerTargetBlock,
      targetBodyDigest: pullRequestBodyDigest(winnerTarget), now, expiresAt, redrive: winnerRedrive });
    const loserTargetBlock = renderIssueLinksBlock({ repositoryId, pullRequestNumber, baseSha, headSha, generation: 0, analysisInputDigest: "d".repeat(64) }, []);
    const loserTarget = upsertIssueLinksBlock(before, loserTargetBlock);
    const loserRedrive = { workflow: "pr-issue-link.yml", inputs: { deliveryId: "delivery-loser", repositoryId: String(repositoryId), pullRequestNumber: String(pullRequestNumber), scanAll: "false", invalidateOnly: "false", cleanupUnmanaged: "false", policySha: "a".repeat(40) } } as const;
    await expect(store.prepare({ repositoryId, pullRequestNumber, writeId: "44444444-4444-4444-8444-444444444444", regionKind: "issue-links", baseSha, headSha, issueGeneration: 0,
      beforeBodyDigest: pullRequestBodyDigest(before), outsideBodyDigest: bodyOutsideManagedRegionDigest(before, "issue-links"), targetBlock: loserTargetBlock,
      targetBodyDigest: pullRequestBodyDigest(loserTarget), now, expiresAt, redrive: loserRedrive })).rejects.toThrow("body-write-intent-conflict");
    expect((await store.get(repositoryId, pullRequestNumber))?.writeId).toBe("11111111-1111-4111-8111-111111111111");
    await store.markPatched(repositoryId, pullRequestNumber, "11111111-1111-4111-8111-111111111111", now);
    await store.proveDelivery({ repositoryId, pullRequestNumber, writeId: "11111111-1111-4111-8111-111111111111", deliveryId: "delivery-conflict", now });
    await store.confirm(repositoryId, pullRequestNumber, "11111111-1111-4111-8111-111111111111", now);
    expect(await store.listPendingRedrives()).toEqual([expect.objectContaining({ repositoryId, pullRequestNumber, writeId: "11111111-1111-4111-8111-111111111111", redrive: loserRedrive })]);
  });

  it("重新调度声明使用持久租约并允许失败释放或超时重试", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const { writeId } = await prepared(store, before, managedBlock("新摘要"));
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    await store.proveDelivery({ repositoryId, pullRequestNumber, writeId, deliveryId: "delivery-redrive-lease", now });
    await store.confirm(repositoryId, pullRequestNumber, writeId, now);
    await store.requestRedrive(repositoryId, pullRequestNumber, writeId, now);

    expect(await store.claimRedrive(repositoryId, pullRequestNumber, writeId, "2026-08-22T00:01:00.000Z", "2026-08-21T22:01:00.000Z")).toBe(true);
    expect(await store.claimRedrive(repositoryId, pullRequestNumber, writeId, "2026-08-22T00:02:00.000Z", "2026-08-21T22:02:00.000Z")).toBe(false);
    expect(await store.listPendingRedrives(20, "2026-08-22T00:00:59.999Z")).toEqual([]);
    expect(await store.listPendingRedrives(20, "2026-08-22T00:01:00.000Z")).toEqual([expect.objectContaining({ writeId })]);
    expect(await store.releaseRedrive(repositoryId, pullRequestNumber, writeId, "2026-08-22T00:01:00.000Z")).toBe(true);
    expect(await store.listPendingRedrives()).toEqual([expect.objectContaining({ writeId })]);
  });

  it("同一目标的重复prepare复用原活动意图以恢复中断写入", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const targetBlock = managedBlock("新摘要");
    const { target, writeId } = await prepared(store, before, targetBlock);
    const repeated = await store.prepare({ repositoryId, pullRequestNumber, writeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", regionKind: "managed-pr", baseSha, headSha, issueGeneration: 0,
      beforeBodyDigest: pullRequestBodyDigest(before), outsideBodyDigest: bodyOutsideManagedRegionDigest(before, "managed-pr"), targetBlock,
      targetBodyDigest: pullRequestBodyDigest(target), now, expiresAt });
    expect(repeated.writeId).toBe(writeId);
    expect(repeated.status).toBe("prepared");
    expect(await store.listPendingRedrives()).toEqual([]);
  });

  it("Webhook先于Runner回报时对同一写入意图幂等接受已PATCH状态", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const { writeId } = await prepared(store, before, managedBlock("新摘要"));
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    await store.proveDelivery({ repositoryId, pullRequestNumber, writeId, deliveryId: "delivery-before-runner", now });

    const repeated = await store.markPatched(repositoryId, pullRequestNumber, writeId, now);

    expect(repeated.status).toBe("patched");
    expect(repeated.deliveryProven).toBe(true);
    expect(repeated.lastDeliveryId).toBe("delivery-before-runner");
    expect(repeated.attemptCount).toBe(1);
  });

  it("补偿代次固定封顶且不会被无限PATCH", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    const targetBlock = managedBlock("新摘要");
    const { writeId } = await prepared(store, before, targetBlock);
    await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    for (let generation = 0; generation < 4; generation += 1) {
      await store.beginCompensation({ repositoryId, pullRequestNumber, writeId, deliveryId: `delivery-${generation}`, beforeBodyDigest: "1".repeat(64), outsideBodyDigest: "2".repeat(64), targetBodyDigest: "3".repeat(64), now });
      await store.markPatched(repositoryId, pullRequestNumber, writeId, now);
    }
    await expect(store.beginCompensation({ repositoryId, pullRequestNumber, writeId, deliveryId: "delivery-5", beforeBodyDigest: "1".repeat(64), outsideBodyDigest: "2".repeat(64), targetBodyDigest: "3".repeat(64), now })).rejects.toThrow("补偿上限");
  });

  it("超过固定恢复窗口的意图进入blocked而不是永久重试", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const before = body("人工前言", managedBlock("旧摘要"));
    await prepared(store, before, managedBlock("新摘要"));
    expect(await store.blockExpired("2026-08-22T00:11:00.000Z")).toBe(1);
    expect(await store.listRecoverable("2026-08-22T00:11:00.000Z")).toEqual([]);
    expect((await store.get(repositoryId, pullRequestNumber))?.blockedReason).toBe("recovery-window-expired");
  });
});
