import { createHmac, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { extractManagedPullRequestBlock, renderManagedBody } from "../../core/src/automation.js";
import worker, { handleWebhook, recoverPullRequestBodyWriteIntents, type Env } from "../src/index.js";
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
    this.database.exec(readFileSync(new URL("../migrations/0004_issue_snapshot_state_revision.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0005_issue_snapshot_reconciliation_revision.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0006_pull_request_body_write_intents.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0007_pull_request_body_write_redrive.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0008_issue_snapshot_reconciliation_redrive.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0009_pull_request_body_write_pull_base.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../migrations/0010_release_receipts.sql", import.meta.url), "utf8"));
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

const repository = (id = 1296724484, fullName = "splrad/steward") => ({ id, full_name: fullName, private: false, has_issues: true, archived: false, disabled: false, owner: { id: 302208797, login: "splrad" } });
const env = (database: SqliteD1): Env => ({
  ORGANIZATION_ID: "302208797", ORGANIZATION_LOGIN: "splrad", APP_ID: "4243096", INSTALLATION_ID: "145952003",
  STEWARDSHIP_REPOSITORY: "splrad/steward", POLICY_SHA: "a".repeat(40), STEWARD_APP_PRIVATE_KEY: privateKey,
  STEWARD_WEBHOOK_SECRET: "webhook-secret", ISSUE_SNAPSHOTS: database.binding(),
});

function signedRequest(event: string, payload: unknown): Request {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", "webhook-secret").update(body).digest("hex");
  return new Request("https://example.test/github/webhook", { method: "POST", body, headers: { "x-github-event": event, "x-github-delivery": "delivery-1", "x-hub-signature-256": `sha256=${signature}` } });
}

function installAuthorization(fetchIssue?: (url: string) => Response | undefined, repositories: any[] = [repository()], installationId = 145952003, viewerLogin = "splrad-steward[bot]") {
  const targetRepository = repositories[0] ?? repository();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const value = String(url);
    if (value.includes("/installation/repositories?per_page=100")) return new Response(JSON.stringify({ total_count: repositories.length, repositories }), { status: 200 });
    if (value.endsWith(`/repos/${targetRepository.full_name}/installation`)) return new Response(JSON.stringify({ id: installationId, app_id: 4243096 }), { status: 200 });
    if (value.endsWith("/app")) return new Response(JSON.stringify({ id: 4243096, slug: "splrad-steward" }), { status: 200 });
    if (value.endsWith("/graphql")) return new Response(JSON.stringify({ data: { viewer: { login: viewerLogin } } }), { status: 200 });
    if (value.endsWith(`/repos/${targetRepository.full_name}`)) return new Response(JSON.stringify(targetRepository), { status: 200 });
    return fetchIssue?.(value) ?? new Response("unexpected", { status: 500 });
  });
}

describe("共享正文接口和恢复", () => {
  it.each([
    ["多仓令牌", [repository(), repository(42, "splrad/other")], 145952003, "splrad-steward[bot]"],
    ["错误仓库", [repository(42, "splrad/other")], 145952003, "splrad-steward[bot]"],
    ["错误安装", [repository()], 1, "splrad-steward[bot]"],
    ["个人令牌", [repository()], 145952003, "alice"],
    ["已归档", [{ ...repository(), archived: true }], 145952003, "splrad-steward[bot]"],
    ["已禁用", [{ ...repository(), disabled: true }], 145952003, "splrad-steward[bot]"],
  ] as const)("正文接口拒绝%s", async (_name, repositories, installation, viewer) => {
    const database = new SqliteD1();
    installAuthorization(undefined, [...repositories], installation, viewer);
    const response = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/active", {
      headers: { authorization: "Bearer token" },
    }), env(database));
    expect(response.status).toBe(403);
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM pull_request_body_write_intents").get()).toEqual({ count: 0 });
  });

  it("旧快照路由不触发鉴权或存储，正文接口仍要求令牌", async () => {
    const database = new SqliteD1();
    const remote = vi.fn(); vi.stubGlobal("fetch", remote);
    for (const suffix of ["", "/issues", "/reconciliation", "/42"]) {
      expect((await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484${suffix}`), env(database))).status).toBe(404);
    }
    expect((await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/active"), env(database))).status).toBe(401);
    expect(remote).not.toHaveBeenCalled();
  });

  it("增量迁移保留历史表并增加发布收据和证据表", () => {
    const database = new SqliteD1();
    const objects = database.database.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    expect(objects).toEqual([
      { type: "index", name: "issue_snapshot_reconciliation_dispatch_idx", tbl_name: "issue_snapshot_reconciliation_requests" },
      { type: "index", name: "issue_snapshots_open", tbl_name: "issue_snapshots" },
      { type: "index", name: "pull_request_body_write_deliveries_intent", tbl_name: "pull_request_body_write_deliveries" },
      { type: "index", name: "pull_request_body_write_intents_pending", tbl_name: "pull_request_body_write_intents" },
      { type: "index", name: "pull_request_body_write_intents_redrive", tbl_name: "pull_request_body_write_intents" },
      { type: "index", name: "release_receipts_current", tbl_name: "release_receipts" },
      { type: "table", name: "issue_snapshot_issue_tombstones", tbl_name: "issue_snapshot_issue_tombstones" },
      { type: "table", name: "issue_snapshot_reconciliation_requests", tbl_name: "issue_snapshot_reconciliation_requests" },
      { type: "table", name: "issue_snapshot_repositories", tbl_name: "issue_snapshot_repositories" },
      { type: "table", name: "issue_snapshot_repository_tombstones", tbl_name: "issue_snapshot_repository_tombstones" },
      { type: "table", name: "issue_snapshots", tbl_name: "issue_snapshots" },
      { type: "table", name: "pull_request_body_write_deliveries", tbl_name: "pull_request_body_write_deliveries" },
      { type: "table", name: "pull_request_body_write_intents", tbl_name: "pull_request_body_write_intents" },
      { type: "table", name: "release_evidence_chunks", tbl_name: "release_evidence_chunks" },
      { type: "table", name: "release_receipts", tbl_name: "release_receipts" },
    ]);
    const source = readFileSync(new URL("../src/pr-body-api.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:FROM|UPDATE|DELETE FROM) issue_snapshots WHERE issue_number/u);
  });

  it("正文写意图接口复用单仓App鉴权并按write_id推进状态", async () => {
    const database = new SqliteD1();
    installAuthorization();
    const writeId = "11111111-1111-4111-8111-111111111111";
    const targetBlock = extractManagedPullRequestBlock(renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: `<!-- workflow:managed-pr:start -->
<!-- workflow:managed-pr:end -->
`, actor: "splrad-steward[bot]", contributors: [], context: "test" })).block;
    const prepare = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/prepare", {
      method: "POST",
      headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" },
      body: JSON.stringify({ writeId, regionKind: "managed-pr", baseSha: "b".repeat(40), pullBaseSha: "e".repeat(40), headSha: "c".repeat(40), issueGeneration: 0,
        beforeBodyDigest: pullRequestBodyDigest("before"), outsideBodyDigest: pullRequestBodyDigest("outside"), targetBlock, targetBodyDigest: pullRequestBodyDigest("after"),
        redrive: { workflow: "sync-review-instructions.yml", inputs: { repositoryId: "1296724484" } } }),
    }), env(database));
    expect(prepare.status).toBe(200);
    expect(await prepare.json()).toEqual(expect.objectContaining({ writeId, baseSha: "b".repeat(40), pullBaseSha: "e".repeat(40), status: "prepared", deliveryProven: false }));
    database.database.prepare("UPDATE pull_request_body_write_intents SET pull_base_sha = NULL").run();
    const pullBase = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/${writeId}/pull-base`, {
      method: "POST", headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" }, body: JSON.stringify({ pullBaseSha: "e".repeat(40) }),
    }), env(database));
    expect(pullBase.status).toBe(200);
    expect(await pullBase.json()).toEqual(expect.objectContaining({ writeId, pullBaseSha: "e".repeat(40), status: "prepared" }));
    const patched = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/${writeId}/patched`, { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual(expect.objectContaining({ writeId, status: "patched", attemptCount: 1 }));
    const readback = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/${writeId}`, { headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(readback.status).toBe(200);
    expect(readback.headers.get("cache-control")).toBe("no-store");
    const active = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/active", { headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual(expect.objectContaining({ writeId, status: "patched" }));

    const intentStore = new PullRequestBodyWriteIntentStore(database.binding());
    await intentStore.proveDelivery({ repositoryId: 1296724484, pullRequestNumber: 42, writeId, deliveryId: "delivery-runtime-wait", now: new Date().toISOString() });
    await intentStore.confirm(1296724484, 42, writeId, new Date().toISOString());
    const waited = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/${writeId}/wait`, {
      method: "POST", headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" }, body: JSON.stringify({ attempts: 1 }),
    }), env(database));
    expect(waited.status).toBe(200);
    expect(await waited.json()).toEqual(expect.objectContaining({ writeId, status: "confirmed" }));
    const claimedAt = new Date().toISOString();
    await intentStore.requestRedrive(1296724484, 42, writeId, claimedAt);
    const prematureCompletion = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/${writeId}/redrive-completed`, { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(prematureCompletion.status).toBe(400);
    expect(await intentStore.claimRedrive(1296724484, 42, writeId, claimedAt, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())).toBe(true);
    const redriveCompleted = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/${writeId}/redrive-completed`, { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database));
    expect(redriveCompleted.status).toBe(200);
    expect(await intentStore.listPendingRedrives()).toEqual([]);

    for (const missingWriteId of ["99999999-9999-4999-8999-999999999999", writeId]) {
      const number = missingWriteId === writeId ? 43 : 42;
      const missing = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/${number}/${missingWriteId}/patched`, { method: "POST", headers: { authorization: "Bearer one-repository-token" } }), env(database));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "body-write-intent-not-found" });
    }
  });

  it("PR对象base接口区分非法请求和存储故障", async () => {
    const database = new SqliteD1();
    installAuthorization();
    const writeId = "11111111-1111-4111-8111-111111111111";
    const targetBlock = extractManagedPullRequestBlock(renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: `<!-- workflow:managed-pr:start -->
<!-- workflow:managed-pr:end -->
`, actor: "splrad-steward[bot]", contributors: [], context: "test" })).block;
    const prepare = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/prepare", {
      method: "POST", headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" },
      body: JSON.stringify({ writeId, regionKind: "managed-pr", baseSha: "b".repeat(40), pullBaseSha: "e".repeat(40), headSha: "c".repeat(40), issueGeneration: 0,
        beforeBodyDigest: pullRequestBodyDigest("before"), outsideBodyDigest: pullRequestBodyDigest("outside"), targetBlock, targetBodyDigest: pullRequestBodyDigest("after"),
        redrive: { workflow: "sync-review-instructions.yml", inputs: { repositoryId: "1296724484" } } }),
    }), env(database));
    expect(prepare.status).toBe(200);
    database.database.prepare("UPDATE pull_request_body_write_intents SET pull_base_sha = NULL").run();

    for (const body of [{ pullBaseSha: "invalid" }, { pullBaseSha: "A".repeat(40) }, { pullBaseSha: 42 }, {}]) {
      const response = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/${writeId}/pull-base`, {
        method: "POST", headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" }, body: JSON.stringify(body),
      }), env(database));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid-internal-request" });
      expect(database.database.prepare("SELECT pull_base_sha FROM pull_request_body_write_intents WHERE write_id = ?").get(writeId)).toEqual({ pull_base_sha: null });
    }

    database.database.prepare("UPDATE pull_request_body_write_intents SET pull_base_sha = 'invalid' WHERE write_id = ?").run(writeId);
    const corrupted = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/active", {
      headers: { authorization: "Bearer one-repository-token" },
    }), env(database));
    expect(corrupted.status).toBe(503);
    expect(await corrupted.json()).toEqual({ error: "body-write-operation-failed" });
  });

  it("等待确认时不会把新写意图作为旧write_id的结果返回", async () => {
    const database = new SqliteD1();
    installAuthorization();
    const writeId = "11111111-1111-4111-8111-111111111111";
    const targetBlock = extractManagedPullRequestBlock(renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: `<!-- workflow:managed-pr:start -->
<!-- workflow:managed-pr:end -->
`, actor: "splrad-steward[bot]", contributors: [], context: "test" })).block;
    const prepare = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/prepare", {
      method: "POST",
      headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" },
      body: JSON.stringify({ writeId, regionKind: "managed-pr", baseSha: "b".repeat(40), headSha: "c".repeat(40), issueGeneration: 0,
        beforeBodyDigest: pullRequestBodyDigest("before"), outsideBodyDigest: pullRequestBodyDigest("outside"), targetBlock, targetBodyDigest: pullRequestBodyDigest("after"),
        redrive: { workflow: "sync-review-instructions.yml", inputs: { repositoryId: "1296724484" } } }),
    }), env(database));
    expect(prepare.status).toBe(200);
    const originalGet = PullRequestBodyWriteIntentStore.prototype.get;
    let reads = 0;
    const get = vi.spyOn(PullRequestBodyWriteIntentStore.prototype, "get").mockImplementation(async function (...args) {
      const current = await originalGet.apply(this, args);
      reads += 1;
      return reads === 3 && current ? { ...current, writeId: "22222222-2222-4222-8222-222222222222" } : current;
    });

    try {
      const waited = await worker.fetch(new Request(`https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/${writeId}/wait`, {
        method: "POST", headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" }, body: JSON.stringify({ attempts: 1 }),
      }), env(database));
      expect(waited.status).toBe(404);
      expect(await waited.json()).toEqual({ error: "body-write-intent-not-found" });
    } finally {
      get.mockRestore();
    }
  });

  it("正文写意图接口把无效JSON和非对象正文映射为400", async () => {
    const database = new SqliteD1();
    for (const body of ["{", "[]", JSON.stringify({ value: "x".repeat(512 * 1024) })]) {
      installAuthorization();
      const response = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/prepare", {
        method: "POST", headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" }, body,
      }), env(database));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid-internal-request" });
    }
    installAuthorization();
    const missingRedrive = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/prepare", {
      method: "POST", headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" }, body: JSON.stringify({
        writeId: "44444444-4444-4444-8444-444444444444", regionKind: "issue-links", baseSha: "b".repeat(40), headSha: "c".repeat(40), issueGeneration: 0,
        beforeBodyDigest: pullRequestBodyDigest("before"), outsideBodyDigest: pullRequestBodyDigest("outside"), targetBlock: null, targetBodyDigest: pullRequestBodyDigest("after"),
      }),
    }), env(database));
    expect(missingRedrive.status).toBe(400);
    expect(await missingRedrive.json()).toEqual({ error: "unsupported-body-write-origin" });
  });

  it("正文写意图接口把无效拉取请求编号映射为400", async () => {
    const database = new SqliteD1();
    installAuthorization();
    const response = await worker.fetch(new Request("https://example.test/internal/issue-snapshots/1296724484/body-write-intents/not-a-number/prepare", {
      method: "POST", headers: { authorization: "Bearer one-repository-token", "content-type": "application/json" }, body: "{}",
    }), env(database));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid-pull-request-number" });
  });

  it("证据不足的正文交付持久阻断后返回成功且不进入通用工作流", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const oldBody = renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "旧摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: "<!-- workflow:managed-pr:start -->\n<!-- workflow:managed-pr:end -->\n", actor: "splrad-steward[bot]", contributors: [], context: "old" });
    const targetBody = renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "新摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: oldBody, actor: "splrad-steward[bot]", contributors: [], context: "new" });
    const now = new Date();
    const writeId = "22222222-2222-4222-8222-222222222222";
    await store.prepare({ repositoryId: 1296724484, pullRequestNumber: 42, writeId, regionKind: "managed-pr", baseSha: "b".repeat(40), headSha: "c".repeat(40), issueGeneration: 0,
      beforeBodyDigest: pullRequestBodyDigest(oldBody), outsideBodyDigest: bodyOutsideManagedRegionDigest(oldBody, "managed-pr"), targetBlock: extractManagedPullRequestBlock(targetBody).block,
      targetBodyDigest: pullRequestBodyDigest(targetBody), now: now.toISOString(), expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      redrive: { workflow: "onboard-repository.yml", inputs: { repositoryId: "1296724484", repositoryFullName: "splrad/steward", trigger: "manual", deliveryId: "delivery-onboard", policySha: "a".repeat(40) } } });
    const workflows: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      const workflow = /\/actions\/workflows\/([^/]+)\/dispatches/u.exec(value)?.[1];
      if (workflow) { workflows.push(workflow); return new Response(null, { status: 204 }); }
      return new Response("unexpected", { status: 500 });
    });
    const payload = {
      organization: { id: 302208797 }, installation: { id: 145952003 }, action: "edited", repository: repository(), sender: { id: 301115370 },
      changes: { body: {} }, pull_request: { number: 42, body: targetBody, head: { sha: "c".repeat(40) }, base: { sha: "b".repeat(40), ref: "main" }, user: { id: 301115370 } },
    };
    expect((await handleWebhook(signedRequest("pull_request", payload), env(database))).status).toBe(202);
    expect(await store.get(1296724484, 42)).toEqual(expect.objectContaining({ status: "blocked", blockedReason: "edited-evidence-unavailable" }));
    expect(await store.listPendingRedrives()).toEqual([expect.objectContaining({ repositoryId: 1296724484, pullRequestNumber: 42, writeId })]);
    expect(workflows).toEqual([]);
  });

  it("空队列零请求，旧代开意图保留原文并终止恢复", async () => {
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
      targetBodyDigest: pullRequestBodyDigest(targetBody), now: "2026-08-22T00:00:00Z", expiresAt: "2026-08-22T00:10:00Z",
      redrive: { workflow: "pr-automation.yml", inputs: { deliveryId: "delivery-push", repositoryId: "1296724484", sourceRef: "refs/heads/feature/test", eventAfterSha: "c".repeat(40), sourceActorId: "44151430", sourceActorLogin: "axiomoth", policySha: "a".repeat(40) } } });
    await store.markPatched(1296724484, 42, writeId, "2026-08-22T00:00:01Z");
    expect(await recoverPullRequestBodyWriteIntents(runtimeEnv, new Date("2026-08-22T00:02:00Z"))).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await store.get(1296724484, 42)).toMatchObject({ status: "blocked", blockedReason: "automation-retired", targetBlock: extractManagedPullRequestBlock(targetBody).block, redriveRequired: false });
  });

  it("审查说明正文意图通过原工作流恢复且不注入未声明输入", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const oldBody = renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "旧摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: "<!-- workflow:managed-pr:start -->\n<!-- workflow:managed-pr:end -->\n", actor: "splrad-steward[bot]", contributors: [], context: "old" });
    const targetBody = renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "新摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: oldBody, actor: "splrad-steward[bot]", contributors: [], context: "new" });
    const writeId = "44444444-4444-4444-8444-444444444444";
    await store.prepare({ repositoryId: 1296724484, pullRequestNumber: 42, writeId, regionKind: "managed-pr", baseSha: "b".repeat(40), headSha: "c".repeat(40), issueGeneration: 0,
      beforeBodyDigest: pullRequestBodyDigest(oldBody), outsideBodyDigest: bodyOutsideManagedRegionDigest(oldBody, "managed-pr"), targetBlock: extractManagedPullRequestBlock(targetBody).block,
      targetBodyDigest: pullRequestBodyDigest(targetBody), now: "2026-08-22T00:00:00Z", expiresAt: "2026-08-22T00:10:00Z",
      redrive: { workflow: "sync-review-instructions.yml", inputs: { repositoryId: "1296724484" } } });
    await store.block(1296724484, 42, writeId, "test-recovery", "2026-08-22T00:00:01Z");
    const dispatched: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ ...repository(), default_branch: "main" }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/sync-review-instructions.yml/dispatches")) { dispatched.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
      return new Response("unexpected", { status: 500 });
    });
    expect(await recoverPullRequestBodyWriteIntents(env(database), new Date("2026-08-22T00:02:00Z"))).toBe(0);
    expect(dispatched).toEqual([{ ref: "main", inputs: { repositoryId: "1296724484" } }]);
    expect(await store.listPendingRedrives()).toEqual([]);
    expect(await recoverPullRequestBodyWriteIntents(env(database), new Date("2026-08-22T00:03:00Z"))).toBe(0);
    expect(dispatched).toHaveLength(1);
    expect(await recoverPullRequestBodyWriteIntents(env(database), new Date("2026-08-22T02:02:00Z"))).toBe(0);
    expect(dispatched).toEqual([
      { ref: "main", inputs: { repositoryId: "1296724484" } },
      { ref: "main", inputs: { repositoryId: "1296724484" } },
    ]);
  });

  it("缺少来源的恢复项被隔离且不阻断后续工作流", async () => {
    const database = new SqliteD1();
    const store = new PullRequestBodyWriteIntentStore(database.binding());
    const oldBody = renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "旧摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: "<!-- workflow:managed-pr:start -->\n<!-- workflow:managed-pr:end -->\n", actor: "splrad-steward[bot]", contributors: [], context: "old" });
    const targetBody = renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "新摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: oldBody, actor: "splrad-steward[bot]", contributors: [], context: "new" });
    const targetBlock = extractManagedPullRequestBlock(targetBody).block;
    const prepare = async (pullRequestNumber: number, writeId: string, redrive?: any) => {
      await store.prepare({ repositoryId: 1296724484, pullRequestNumber, writeId, regionKind: "managed-pr", baseSha: "b".repeat(40), headSha: "c".repeat(40), issueGeneration: 0,
        beforeBodyDigest: pullRequestBodyDigest(oldBody), outsideBodyDigest: bodyOutsideManagedRegionDigest(oldBody, "managed-pr"), targetBlock,
        targetBodyDigest: pullRequestBodyDigest(targetBody), now: `2026-08-22T00:00:0${pullRequestNumber - 41}Z`, expiresAt: "2026-08-22T00:10:00Z", redrive });
      await store.block(1296724484, pullRequestNumber, writeId, "test-recovery", `2026-08-22T00:00:0${pullRequestNumber - 40}Z`);
    };
    await prepare(42, "55555555-5555-4555-8555-555555555555");
    await prepare(43, "66666666-6666-4666-8666-666666666666", { workflow: "sync-review-instructions.yml", inputs: { repositoryId: "1296724484" } });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatched: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const value = String(url);
      if (value.includes("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      if (value.endsWith("/repos/splrad/steward")) return new Response(JSON.stringify({ ...repository(), default_branch: "main" }), { status: 200 });
      if (value.endsWith("/repos/splrad/steward/actions/workflows/sync-review-instructions.yml/dispatches")) { dispatched.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
      return new Response("unexpected", { status: 500 });
    });

    expect(await recoverPullRequestBodyWriteIntents(env(database), new Date("2026-08-22T00:02:00Z"))).toBe(1);
    expect(dispatched).toEqual([{ ref: "main", inputs: { repositoryId: "1296724484" } }]);
    expect(warnings).not.toHaveBeenCalled();
    expect((await store.get(1296724484, 42))?.blockedReason).toBe("automation-retired");
    expect(database.database.prepare("SELECT redrive_required, redrive_dispatched FROM pull_request_body_write_intents WHERE pull_request_number=42").get())
      .toEqual({ redrive_required: 0, redrive_dispatched: 0 });
    expect(await store.listPendingRedrives()).toEqual([]);
  });
});
