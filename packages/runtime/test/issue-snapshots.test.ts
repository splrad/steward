import { createHmac, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { issueSnapshotContentDigest, normalizeIssueSnapshot, openIssueSetDigest, renderIssueLinksBlock, type IssueSnapshot } from "../../core/src/issues.js";
import { extractManagedPullRequestBlock, renderManagedBody } from "../../core/src/automation.js";
import worker, { handleWebhook, recoverPullRequestBodyWriteIntents, type Env } from "../src/index.js";
import { IssueSnapshotStore } from "../src/issue-snapshots.js";
import { bodyOutsideManagedRegionDigest, pullRequestBodyDigest, PullRequestBodyWriteIntentStore } from "../src/pr-body-write-intents.js";

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
    this.database.exec(readFileSync(new URL("../migrations/0001_issue_snapshots.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0002_issue_snapshot_tombstones.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0003_issue_snapshot_reconciliation.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0004_pull_request_body_write_intents.sql", import.meta.url), "utf8"));
  }
  prepare(sql: string): D1PreparedStatement { return new SqliteD1Statement(this.database, sql) as unknown as D1PreparedStatement; }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  binding(): D1Database { return this as unknown as D1Database; }
}

let privateKey = "";
beforeAll(() => {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } }).privateKey;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const repository = (id = 1296724484, fullName = "splrad/steward") => ({ id, full_name: fullName, private: false, owner: { id: 302208797, login: "splrad" } });
const env = (database: SqliteD1): Env => ({
  ORGANIZATION_ID: "302208797", ORGANIZATION_LOGIN: "splrad", APP_ID: "4243096", INSTALLATION_ID: "145952003",
  STEWARDSHIP_REPOSITORY: "splrad/steward", POLICY_SHA: "a".repeat(40), STEWARD_APP_PRIVATE_KEY: privateKey,
  STEWARD_WEBHOOK_SECRET: "webhook-secret", ISSUE_SNAPSHOTS: database.binding(),
});

function snapshot(repositoryId: number, fullName: string, issueNumber: number, title = "议题", body = "明确的验收要求"): IssueSnapshot {
  return normalizeIssueSnapshot({
    repository: { id: repositoryId, fullName },
    issue: { number: issueNumber, title, body, state: "open", labels: ["bug"], milestone: null, stateReason: null, issueType: null, fieldValues: [], createdAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T01:00:00Z", commentsCount: 0 },
    comments: [], parent: null, subIssues: [], blockedBy: [], blocking: [],
  });
}

async function put(store: IssueSnapshotStore, value: IssueSnapshot, expectedGeneration: number, deliveryId = "delivery-1") {
  return store.putSnapshot({ expectedGeneration, snapshot: value, contentDigest: issueSnapshotContentDigest(value), validators: [], deliveryId, now: "2026-08-21T00:00:00Z" });
}

function signedRequest(event: string, payload: unknown): Request {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", "webhook-secret").update(body).digest("hex");
  return new Request("https://example.test/github/webhook", { method: "POST", body, headers: { "x-github-event": event, "x-github-delivery": "delivery-1", "x-hub-signature-256": `sha256=${signature}` } });
}

function installAuthorization(fetchIssue?: (url: string) => Response | undefined, repositories: any[] = [repository()], installationId = 145952003, viewerLogin = "splrad-steward[bot]") {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const value = String(url);
    if (value.includes("/installation/repositories?per_page=100")) return new Response(JSON.stringify({ total_count: repositories.length, repositories }), { status: 200 });
    if (value.endsWith("/repos/splrad/steward/installation")) return new Response(JSON.stringify({ id: installationId, app_id: 4243096 }), { status: 200 });
    if (value.endsWith("/app")) return new Response(JSON.stringify({ id: 4243096, slug: "splrad-steward" }), { status: 200 });
    if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { viewer: { login: viewerLogin } } }), { status: 200 });
    if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify(repository()), { status: 200 });
    return fetchIssue?.(value) ?? new Response("unexpected", { status: 500 });
  });
}

describe("议题快照D1存储", () => {
  it("迁移只创建固定快照、墓碑、重算请求和正文写意图表", () => {
    const database = new SqliteD1();
    const objects = database.database.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    expect(objects).toEqual([
      { type: "index", name: "issue_snapshots_open", tbl_name: "issue_snapshots" },
      { type: "index", name: "pull_request_body_write_deliveries_intent", tbl_name: "pull_request_body_write_deliveries" },
      { type: "index", name: "pull_request_body_write_intents_pending", tbl_name: "pull_request_body_write_intents" },
      { type: "index", name: "pull_request_body_write_intents_redrive", tbl_name: "pull_request_body_write_intents" },
      { type: "table", name: "issue_snapshot_issue_tombstones", tbl_name: "issue_snapshot_issue_tombstones" },
      { type: "table", name: "issue_snapshot_reconciliation_requests", tbl_name: "issue_snapshot_reconciliation_requests" },
      { type: "table", name: "issue_snapshot_repositories", tbl_name: "issue_snapshot_repositories" },
      { type: "table", name: "issue_snapshot_repository_tombstones", tbl_name: "issue_snapshot_repository_tombstones" },
      { type: "table", name: "issue_snapshots", tbl_name: "issue_snapshots" },
      { type: "table", name: "pull_request_body_write_deliveries", tbl_name: "pull_request_body_write_deliveries" },
      { type: "table", name: "pull_request_body_write_intents", tbl_name: "pull_request_body_write_intents" },
    ]);
    const source = readFileSync(new URL("../src/issue-snapshots.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:FROM|UPDATE|DELETE FROM) issue_snapshots WHERE issue_number/u);
  });

  it("同号议题按仓库隔离，迟到写入不能覆盖较新的代次", async () => {
    const database = new SqliteD1(); const store = new IssueSnapshotStore(database.binding());
    const steward = snapshot(1296724484, "splrad/steward", 7, "Steward议题");
    const layerScape = snapshot(1187527897, "splrad/LayerScape", 7, "LayerScape议题");
    expect((await put(store, steward, 0)).state.generation).toBe(1);
    expect((await put(store, layerScape, 0)).state.generation).toBe(1);
    expect((await store.getSnapshot(1296724484, 7))?.snapshot.issue.title).toBe("Steward议题");
    expect((await store.getSnapshot(1187527897, 7))?.snapshot.issue.title).toBe("LayerScape议题");

    const stale = snapshot(1296724484, "splrad/steward", 7, "迟到结果");
    await expect(put(store, stale, 0)).rejects.toThrow("issue-snapshot-generation-conflict");
    expect((await store.getSnapshot(1296724484, 7))?.snapshot.issue.title).toBe("Steward议题");
    expect((await put(store, steward, 1, "delivery-repeat")).changed).toBe(false);
    expect((await store.getRepositoryState(1296724484))?.generation).toBe(1);
    expect(await store.getReconciliationRequest(1296724484)).toEqual(expect.objectContaining({ generation: 1 }));
    expect(await store.acknowledgeReconciliation(1296724484, 0)).toBe(false);
    expect(await store.acknowledgeReconciliation(1296724484, 1)).toBe(true);
    expect(await store.getReconciliationRequest(1296724484)).toBeNull();
  });

  it("缺失快照的删除也推进墓碑代次，迟到刷新不能复活议题", async () => {
    const store = new IssueSnapshotStore(new SqliteD1().binding());
    const value = snapshot(1296724484, "splrad/steward", 44);
    const deleted = await store.deleteSnapshot(1296724484, 44, 0, "2026-08-21T00:00:00Z");
    expect(deleted).toEqual(expect.objectContaining({ changed: true, state: expect.objectContaining({ generation: 1 }) }));
    await expect(put(store, value, 0, "late-refresh")).rejects.toThrow("issue-snapshot-generation-conflict");
    expect((await store.deleteSnapshot(1296724484, 44, 1, "2026-08-21T00:01:00Z")).changed).toBe(false);
    await expect(put(store, value, 1, "reopened-refresh")).resolves.toEqual(expect.objectContaining({ changed: true, state: expect.objectContaining({ generation: 2 }) }));
  });

  it("扫描只有在实时开放集合与D1集合完全一致时才能就绪", async () => {
    const store = new IssueSnapshotStore(new SqliteD1().binding());
    await store.setScanState(1296724484, "scanning", 0, "2026-08-21T00:00:00Z");
    await put(store, snapshot(1296724484, "splrad/steward", 7), 0);
    await expect(store.setScanState(1296724484, "ready", 1, "2026-08-21T00:01:00Z", [])).rejects.toThrow("开放议题集合尚未收敛");
    const ready = await store.setScanState(1296724484, "ready", 1, "2026-08-21T00:02:00Z", [7]);
    expect(ready).toEqual(expect.objectContaining({ generation: 1, syncState: "ready", openSetDigest: openIssueSetDigest(1296724484, [7]), lastFullScanAt: "2026-08-21T00:02:00Z" }));
    expect(await store.getReconciliationRequest(1296724484)).toEqual(expect.objectContaining({ generation: 1 }));
  });

  it("删除始终绑定复合主键，仓库清理不影响另一个仓库的同号议题", async () => {
    const store = new IssueSnapshotStore(new SqliteD1().binding());
    const layerScape = snapshot(1187527897, "splrad/LayerScape", 7);
    await put(store, snapshot(1296724484, "splrad/steward", 7), 0);
    await put(store, layerScape, 0);
    const deleted = await store.deleteSnapshot(1296724484, 7, 1, "2026-08-21T00:03:00Z");
    expect(deleted.changed).toBe(true);
    expect(await store.getSnapshot(1296724484, 7)).toBeNull();
    expect(await store.getSnapshot(1187527897, 7)).not.toBeNull();
    await store.deleteRepository(1187527897);
    expect(await store.getRepositoryState(1187527897)).toBeNull();
    await expect(put(store, layerScape, 0, "late-delivery")).rejects.toThrow("issue-snapshot-generation-conflict");
    await store.activateRepository(1187527897);
    await expect(put(store, layerScape, 0, "re-added")).resolves.toEqual(expect.objectContaining({ changed: true }));
  });

  it("开放候选总量在写入时受1 MiB固定上限约束", async () => {
    const store = new IssueSnapshotStore(new SqliteD1().binding());
    let generation = 0;
    for (let issueNumber = 1; issueNumber <= 4; issueNumber++) {
      const large = snapshot(1296724484, "splrad/steward", issueNumber, "大快照", `${issueNumber}${"x".repeat(210_000)}`);
      generation = (await put(store, large, generation)).state.generation;
    }
    const tooLarge = snapshot(1296724484, "splrad/steward", 5, "大快照", `5${"x".repeat(210_000)}`);
    await expect(put(store, tooLarge, generation)).rejects.toThrow("开放议题候选超过固定上限");
  });
});

describe("议题快照内部接口", () => {
  it("路径中的仓库和议题编号必须是正安全整数", async () => {
    const database = new SqliteD1();
    for (const path of ["0", "9007199254740992", "not-a-number"]) {
      expect((await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/${path}`, { headers: { authorization: "Bearer token" } }), env(database))).status).toBe(400);
    }
    installAuthorization();
    for (const issueNumber of ["0", "9007199254740992", "not-a-number"]) {
      expect((await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/${issueNumber}/refresh`, { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database))).status).toBe(400);
    }
  });

  it("拒绝普通PAT、宽令牌、其他应用和错误安装，只允许唯一目标仓库", async () => {
    const database = new SqliteD1();
    vi.stubGlobal("fetch", async () => new Response("bad credentials", { status: 401 }));
    expect((await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484", { headers: { authorization: "Bearer pat-token" } }), env(database))).status).toBe(401);

    installAuthorization(undefined, [repository(), repository(1187527897, "splrad/LayerScape")]);
    expect((await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484", { headers: { authorization: "Bearer wide-token" } }), env(database))).status).toBe(403);

    installAuthorization(undefined, [repository()], 999);
    expect((await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484", { headers: { authorization: "Bearer wrong-installation" } }), env(database))).status).toBe(403);

    installAuthorization(undefined, [repository()], 145952003, "other-app[bot]");
    expect((await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484", { headers: { authorization: "Bearer other-app-token" } }), env(database))).status).toBe(403);

    installAuthorization();
    const accepted = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484", { headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(await accepted.json()).toEqual(expect.objectContaining({ repositoryId: 1296724484, generation: 0, syncState: "uninitialized", snapshots: [] }));
  });

  it("正文写意图接口复用单仓App鉴权并按write_id推进状态", async () => {
    const database = new SqliteD1();
    installAuthorization();
    const writeId = "11111111-1111-4111-8111-111111111111";
    const targetBlock = renderIssueLinksBlock({ repositoryId: 1296724484, pullRequestNumber: 42, baseSha: "b".repeat(40), headSha: "c".repeat(40), generation: 0, analysisInputDigest: "d".repeat(64) }, []);
    const prepare = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/prepare", {
      method: "POST",
      headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" },
      body: JSON.stringify({ writeId, regionKind: "issue-links", baseSha: "b".repeat(40), headSha: "c".repeat(40), issueGeneration: 0,
        beforeBodyDigest: pullRequestBodyDigest("before"), outsideBodyDigest: pullRequestBodyDigest("outside"), targetBlock, targetBodyDigest: pullRequestBodyDigest("after") }),
    }), env(database));
    expect(prepare.status).toBe(200);
    expect(await prepare.json()).toEqual(expect.objectContaining({ writeId, status: "prepared", deliveryProven: false }));
    const patched = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/${writeId}/patched`, { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual(expect.objectContaining({ writeId, status: "patched", attemptCount: 1 }));
    const readback = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/${writeId}`, { headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(readback.status).toBe(200);
    expect(readback.headers.get("cache-control")).toBe("no-store");
  });

  it("调用者不能提交删除指令，上游歧义也不会删除已有快照", async () => {
    const database = new SqliteD1(); const store = new IssueSnapshotStore(database.binding());
    await put(store, snapshot(1296724484, "splrad/steward", 7), 0);
    installAuthorization();
    const forged = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/7/refresh", { method: "POST", body: JSON.stringify({ delete: true }), headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" } }), env(database));
    expect(forged.status).toBe(400);
    expect(await store.getSnapshot(1296724484, 7)).not.toBeNull();

    installAuthorization((url) => url.endsWith("/issues/7") ? new Response("temporary", { status: 500 }) : undefined);
    const ambiguous = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/7/refresh", { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(ambiguous.status).toBe(502);
    expect(await store.getSnapshot(1296724484, 7)).not.toBeNull();

    installAuthorization((url) => {
      if (url.endsWith("/issues/7")) return new Response(JSON.stringify({ number: 7, repository_url: "https://api.github.com/repos/splrad/LayerScape" }), { status: 200 });
      if (url.endsWith("/issues/7/parent")) return new Response("not found", { status: 404 });
      if (url.includes("/issues/7/")) return new Response(JSON.stringify([]), { status: 200 });
      return undefined;
    });
    const mismatched = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/7/refresh", { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(mismatched.status).toBe(503);
    expect(await store.getSnapshot(1296724484, 7)).not.toBeNull();
  });

  it("只有主议题的权威404能按CAS删除精确复合键", async () => {
    const database = new SqliteD1(); const store = new IssueSnapshotStore(database.binding());
    await put(store, snapshot(1296724484, "splrad/steward", 7), 0);
    await put(store, snapshot(1187527897, "splrad/LayerScape", 7), 0);
    installAuthorization((url) => url.endsWith("/issues/7") ? new Response("not found", { status: 404 }) : undefined);
    const result = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/7/refresh", { method: "POST", headers: { authorization: "Bearer one-repository-token", "x-github-delivery": "delivery-404" } }), env(database));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(expect.objectContaining({ repositoryId: 1296724484, issueNumber: 7, deleted: true, generation: 2 }));
    expect(await store.getSnapshot(1296724484, 7)).toBeNull();
    expect(await store.getSnapshot(1187527897, 7)).not.toBeNull();
  });

  it("刷新只保存Runtime从GitHub完整读取并规范化的当前事实", async () => {
    const database = new SqliteD1();
    installAuthorization((url) => {
      if (url.endsWith("/issues/8")) return new Response(JSON.stringify({
        number: 8, repository_url: "https://api.github.com/repos/splrad/steward", title: "修复同步", body: "验收要求",
        state: "open", labels: [{ name: "bug" }], milestone: null, state_reason: null, type: { name: "Bug" },
        created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T01:00:00Z", comments: 1,
      }), { status: 200, headers: { etag: '"issue"' } });
      if (url.includes("/comments?")) return new Response(JSON.stringify([{ id: 90, user: { login: "octocat" }, body: "补充条件", created_at: "2026-08-20T00:30:00Z", updated_at: "2026-08-20T00:31:00Z" }]), { status: 200, headers: { etag: '"comments"' } });
      if (url.includes("/issue-field-values?")) return new Response(JSON.stringify([{ issue_field_id: 2, issue_field_name: "Priority", data_type: "single_select", value: 1, single_select_option: { id: 1, name: "High", color: "red" } }]), { status: 200, headers: { etag: '"fields"' } });
      if (url.endsWith("/issues/8/parent")) return new Response("not found", { status: 404 });
      if (url.includes("/sub_issues?")) return new Response(JSON.stringify([{ number: 9, repository_url: "https://api.github.com/repos/splrad/steward", title: "子议题", state: "open", updated_at: "2026-08-20T00:20:00Z" }]), { status: 200, headers: { etag: '"children"' } });
      if (url.includes("/dependencies/blocked_by?")) return new Response(JSON.stringify([]), { status: 200, headers: { etag: '"blocked"' } });
      if (url.includes("/dependencies/blocking?")) return new Response(JSON.stringify([]), { status: 200, headers: { etag: '"blocking"' } });
      return undefined;
    });
    const refreshed = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/8/refresh", { method: "POST", headers: { authorization: "Bearer one-repository-token", "x-github-delivery": "delivery-refresh" } }), env(database));
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toEqual(expect.objectContaining({ repositoryId: 1296724484, issueNumber: 8, changed: true, generation: 1 }));
    const saved = await new IssueSnapshotStore(database.binding()).getSnapshot(1296724484, 8);
    expect(saved?.snapshot).toEqual(expect.objectContaining({
      repository: { id: 1296724484, fullName: "splrad/steward" },
      issue: expect.objectContaining({ number: 8, issueType: "Bug", fieldValues: [{ name: "Priority", type: "single_select", value: { color: "red", id: 1, name: "High" } }], commentsCount: 1 }),
      comments: [expect.objectContaining({ id: 90, author: "octocat", body: "补充条件" })],
      subIssues: [{ repositoryId: 1296724484, number: 9, title: "子议题", state: "open", updatedAt: "2026-08-20T00:20:00Z" }],
    }));
    expect(saved?.validators.map((validator) => validator.resource)).toEqual(["issue", "comments", "field-values", "parent", "sub-issues", "blocked-by", "blocking"]);
  });

  it("关闭议题立即删除已有快照，不保留无界历史", async () => {
    const database = new SqliteD1(); const store = new IssueSnapshotStore(database.binding());
    await put(store, snapshot(1296724484, "splrad/steward", 8), 0);
    installAuthorization((url) => {
      if (url.endsWith("/issues/8")) return new Response(JSON.stringify({
        number: 8, repository_url: "https://api.github.com/repos/splrad/steward", title: "已关闭", body: "完成",
        state: "closed", labels: [], milestone: null, state_reason: "completed", type: null,
        created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-21T00:00:00Z", comments: 0,
      }), { status: 200, headers: { etag: '"issue-closed"' } });
      if (url.includes("/issues/8/")) return new Response("unrelated endpoint unavailable", { status: 500 });
      return undefined;
    });
    const response = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/8/refresh", { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ deleted: true, generation: 2 }));
    expect(await store.getSnapshot(1296724484, 8)).toBeNull();
  });

  it("跨仓关系使用按仓库名称收窄的新令牌读取身份", async () => {
    const database = new SqliteD1(); const tokenBodies: any[] = [];
    installAuthorization((url) => {
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "related-repository-token" }), { status: 201 });
      if (url.endsWith("/repos/splrad/LayerScape")) return new Response(JSON.stringify(repository(1187527897, "splrad/LayerScape")), { status: 200 });
      if (url.endsWith("/issues/8")) return new Response(JSON.stringify({
        number: 8, repository_url: "https://api.github.com/repos/splrad/steward", title: "跨仓关系", body: "验收",
        state: "open", labels: [], milestone: null, state_reason: null, type: null,
        created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-21T00:00:00Z", comments: 0,
      }), { status: 200, headers: { etag: '"issue"' } });
      if (url.endsWith("/issues/8/parent")) return new Response("not found", { status: 404 });
      if (url.includes("/sub_issues?")) return new Response(JSON.stringify([{ number: 9, repository_url: "https://api.github.com/repos/splrad/LayerScape", title: "跨仓子议题", state: "open", updated_at: "2026-08-21T00:00:00Z" }]), { status: 200, headers: { etag: '"sub"' } });
      if (url.includes("/issues/8/")) return new Response(JSON.stringify([]), { status: 200, headers: { etag: '"empty"' } });
      return undefined;
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("/access_tokens")) tokenBodies.push(JSON.parse(String(init.body)));
      return originalFetch(url, init);
    });
    const response = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/8/refresh", { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(response.status).toBe(200);
    expect(tokenBodies).toContainEqual({ permissions: { issues: "read", metadata: "read" }, repositories: ["LayerScape"] });
    expect((await new IssueSnapshotStore(database.binding()).getSnapshot(1296724484, 8))?.snapshot.subIssues[0]?.repositoryId).toBe(1187527897);
  });

  it("私有或未纳管的关系仓库不会进入快照", async () => {
    const database = new SqliteD1();
    installAuthorization((url) => {
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: "related-repository-token" }), { status: 201 });
      if (url.endsWith("/repos/splrad/secret")) return new Response(JSON.stringify({ ...repository(999, "splrad/secret"), private: true }), { status: 200 });
      if (url.endsWith("/issues/8")) return new Response(JSON.stringify({
        number: 8, repository_url: "https://api.github.com/repos/splrad/steward", title: "受控关系", body: "验收",
        state: "open", labels: [], milestone: null, state_reason: null, type: null,
        created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-21T00:00:00Z", comments: 0,
      }), { status: 200, headers: { etag: '"issue"' } });
      if (url.endsWith("/issues/8/parent")) return new Response("not found", { status: 404 });
      if (url.includes("/sub_issues?")) return new Response(JSON.stringify([{ number: 9, repository_url: "https://api.github.com/repos/splrad/secret", title: "私有关系", state: "open", updated_at: "2026-08-21T00:00:00Z" }]), { status: 200, headers: { etag: '"sub"' } });
      if (url.includes("/issues/8/")) return new Response(JSON.stringify([]), { status: 200, headers: { etag: '"empty"' } });
      return undefined;
    });
    const response = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/8/refresh", { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(response.status).toBe(503);
    expect(await new IssueSnapshotStore(database.binding()).getSnapshot(1296724484, 8)).toBeNull();
  });

  it("不暴露DELETE路由，scan-state不接受正文且ready会实时复核开放集合", async () => {
    const database = new SqliteD1(); installAuthorization((url) => url.includes("issues?state=open") ? new Response(JSON.stringify([]), { status: 200 }) : undefined);
    expect((await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/7", { method: "DELETE", headers: { authorization: "Bearer one-repository-token" } }), env(database))).status).toBe(404);
    expect((await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/scan-state", { method: "POST", body: "{}", headers: { authorization: "Bearer one-repository-token", "x-steward-scan-state": "ready" } }), env(database))).status).toBe(400);
    const ready = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/scan-state", { method: "POST", headers: { authorization: "Bearer one-repository-token", "x-steward-scan-state": "ready" } }), env(database));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual(expect.objectContaining({ repositoryId: 1296724484, generation: 0, syncState: "ready" }));
  });
});

describe("正文写意图交付恢复", () => {
  it("无待处理意图时零外部请求，有待处理意图时从App交付记录恢复", async () => {
    const database = new SqliteD1();
    const runtimeEnv = env(database);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await recoverPullRequestBodyWriteIntents(runtimeEnv, new Date("2026-08-22T00:01:00Z"))).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    const oldBody = renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "旧摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: "<!-- workflow:managed-pr:start -->\n<!-- workflow:managed-pr:end -->\n", actor: "splrad-steward[bot]", contributors: [], context: "old" });
    const targetBody = renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "新摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: oldBody, actor: "splrad-steward[bot]", contributors: [], context: "new" });
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const writeId = "33333333-3333-4333-8333-333333333333";
    await store.prepare({ repositoryId: 1296724484, pullRequestNumber: 42, writeId, regionKind: "managed-pr", baseSha: "b".repeat(40), headSha: "c".repeat(40), issueGeneration: 0,
      beforeBodyDigest: pullRequestBodyDigest(oldBody), outsideBodyDigest: bodyOutsideManagedRegionDigest(oldBody, "managed-pr"), targetBlock: extractManagedPullRequestBlock(targetBody).block,
      targetBodyDigest: pullRequestBodyDigest(targetBody), now: "2026-08-22T00:00:00Z", expiresAt: "2026-08-22T00:10:00Z" });
    await store.markPatched(1296724484, 42, writeId, "2026-08-22T00:00:01Z");
    const editedPayload = { action: "edited", repository: repository(), sender: { id: 301115370 }, changes: { body: { from: oldBody } }, pull_request: { number: 42, body: targetBody, head: { sha: "c".repeat(40) }, base: { sha: "b".repeat(40) } } };
    const dispatched: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.includes("/app/hook/deliveries?")) return new Response(JSON.stringify([{ id: 9, repository_id: 1296724484, event: "pull_request", action: "edited", guid: "delivery-recovered" }]), { status: 200 });
      if (value.endsWith("/app/hook/deliveries/9")) return new Response(JSON.stringify({ guid: "delivery-recovered", request: { headers: { "X-GitHub-Delivery": "delivery-recovered" }, payload: editedPayload } }), { status: 200 });
      if (value.endsWith("/repositories/1296724484")) return new Response(JSON.stringify(repository()), { status: 200 });
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ ...repository(), default_branch: "main" }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/pr-issue-link.yml/dispatches")) { dispatched.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
      if (value.endsWith("/repos/splrad/steward/pulls/42")) return new Response(JSON.stringify({ number: 42, body: targetBody, head: { sha: "c".repeat(40) }, base: { sha: "b".repeat(40) } }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    expect(await recoverPullRequestBodyWriteIntents(runtimeEnv, new Date("2026-08-22T00:02:00Z"))).toBe(1);
    expect((await store.get(1296724484, 42))?.deliveryProven).toBe(true);
    expect(await recoverPullRequestBodyWriteIntents(runtimeEnv, new Date("2026-08-22T00:03:00Z"))).toBe(1);
    expect((await store.get(1296724484, 42))?.status).toBe("confirmed");
    expect(dispatched).toEqual([expect.objectContaining({ inputs: expect.objectContaining({ repositoryId: "1296724484", pullRequestNumber: "42", scanAll: "false", invalidateOnly: "false" }) })]);
  });
});

describe("已验签Webhook直连清理", () => {
  it("议题删除和安装范围移除直接清理D1，删除后只调度失效与全量收敛", async () => {
    const database = new SqliteD1(); const store = new IssueSnapshotStore(database.binding());
    await put(store, snapshot(1296724484, "splrad/steward", 7), 0);
    await put(store, snapshot(1187527897, "splrad/LayerScape", 7), 0);
    const workflows: string[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 });
      const workflow = /\/actions\/workflows\/([^/]+)\/dispatches/u.exec(value)?.[1];
      if (workflow) { workflows.push(workflow); return new Response(null, { status: 204 }); }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const issuePayload = { organization: { id: 302208797 }, installation: { id: 145952003 }, action: "deleted", repository: { ...repository(), default_branch: "main" }, issue: { number: 7 } };
    expect((await handleWebhook(signedRequest("issues", issuePayload), env(database))).status).toBe(202);
    expect(await store.getSnapshot(1296724484, 7)).toBeNull();
    expect(await store.getSnapshot(1187527897, 7)).not.toBeNull();

    const removedPayload = { installation: { id: 145952003, account: { id: 302208797 } }, action: "removed", repositories_removed: [{ ...repository(1187527897, "splrad/LayerScape"), default_branch: "main" }] };
    expect((await handleWebhook(signedRequest("installation_repositories", removedPayload), env(database))).status).toBe(202);
    expect(await store.getRepositoryState(1187527897)).toBeNull();
    expect(workflows).toEqual(["pr-issue-link.yml", "issue-sync.yml"]);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/internal/issue-snapshots/"))).toBe(false);
  });

  it("安装删除会清理全部仓库并留下防复活墓碑", async () => {
    const database = new SqliteD1(); const store = new IssueSnapshotStore(database.binding());
    const steward = snapshot(1296724484, "splrad/steward", 7);
    const pending = snapshot(1187527897, "splrad/LayerScape", 7);
    await put(store, steward, 0);
    const payload = { installation: { id: 145952003, account: { id: 302208797 } }, action: "deleted", repositories: [repository(), repository(1187527897, "splrad/LayerScape")] };
    expect((await handleWebhook(signedRequest("installation", payload), env(database))).status).toBe(202);
    expect(await store.getRepositoryState(1296724484)).toBeNull();
    await expect(put(store, steward, 0, "late-installation-write")).rejects.toThrow("issue-snapshot-generation-conflict");
    await expect(put(store, pending, 0, "late-uninitialized-write")).rejects.toThrow("issue-snapshot-generation-conflict");
  });
});
