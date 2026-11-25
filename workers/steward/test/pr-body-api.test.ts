import { authorizeSingleRepository } from '../src/pr-body-api.js';
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { extractManagedPullRequestBlock, renderManagedBody } from "../support/core/automation.js";
import worker, { type Env } from "../src/index.js";
import { pullRequestBodyDigest, PullRequestBodyWriteIntentStore } from "../src/pr-body-write-intents.js";


describe('shared runtime', () => {
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
    this.database.exec(readFileSync(new URL("../../../packages/runtime/migrations/0001_issue_snapshots.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../packages/runtime/migrations/0002_issue_snapshot_tombstones.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../packages/runtime/migrations/0003_issue_snapshot_reconciliation.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../packages/runtime/migrations/0004_issue_snapshot_state_revision.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../packages/runtime/migrations/0005_issue_snapshot_reconciliation_revision.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../packages/runtime/migrations/0006_pull_request_body_write_intents.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../packages/runtime/migrations/0007_pull_request_body_write_redrive.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../packages/runtime/migrations/0008_issue_snapshot_reconciliation_redrive.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../packages/runtime/migrations/0009_pull_request_body_write_pull_base.sql", import.meta.url), "utf8"));
    this.database.exec(readFileSync(new URL("../../../packages/runtime/migrations/0010_release_receipts.sql", import.meta.url), "utf8"));
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
    [42, "splrad/new-repository", false, true],
    [42, "splrad/new-repository", true, false],
    [1296724484, "splrad/steward", true, true],
    [1296724484, "splrad/renamed", false, false],
  ] as const)("按目录校验仓库 %s %s 的准入和身份", async (id, fullName, isPrivate, allowed) => {
    installAuthorization(undefined, [{...repository(id, fullName), private: isPrivate}]);
    const request = new Request("https://example.test/status", {headers: {authorization: "Bearer token"}});
    const check = authorizeSingleRepository(request, env(new SqliteD1()), id);
    if (allowed) await expect(check).resolves.toMatchObject({managed: true});
    else await expect(check).rejects.toMatchObject({status: 403});
  });

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

  it("正文写意图接口保留单仓鉴权的历史读取并拒绝旧写入", async () => {
    const database = new SqliteD1();
    installAuthorization();
    const writeId = "11111111-1111-4111-8111-111111111111";
    const targetBlock = extractManagedPullRequestBlock(renderManagedBody({ generated: { type: "chore", scope: "test", title: "测试", summary: "摘要", motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] }, templateBody: `<!-- workflow:managed-pr:start -->
<!-- workflow:managed-pr:end -->
`, actor: "splrad-steward[bot]", contributors: [], context: "test" })).block;
    const historic = await new PullRequestBodyWriteIntentStore(database.binding()).prepare({
      repositoryId:1296724484,pullRequestNumber:42,now:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),
      writeId, regionKind: "managed-pr", baseSha: "b".repeat(40), pullBaseSha: "e".repeat(40), headSha: "c".repeat(40), issueGeneration: 0,
        beforeBodyDigest: pullRequestBodyDigest("before"), outsideBodyDigest: pullRequestBodyDigest("outside"), targetBlock, targetBodyDigest: pullRequestBodyDigest("after"),
        redrive: { workflow: "sync-review-instructions.yml", inputs: { repositoryId: "1296724484" } } });

    expect(historic).toEqual(expect.objectContaining({ writeId, baseSha: "b".repeat(40), pullBaseSha: "e".repeat(40), status: "prepared", deliveryProven: false }));
    database.database.prepare("UPDATE pull_request_body_write_intents SET pull_base_sha = NULL").run();
    const stored = await new PullRequestBodyWriteIntentStore(database.binding()).get(1296724484,42);
    const base = `https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42`;
    const headers = {authorization: "Bearer one-repository-token"};
    for (const action of ["pull-base","patched","block","confirm","redrive-completed","wait"]) {
      const res=await worker.fetch(new Request(`${base}/${writeId}/${action}`,{method:"POST",headers}),env(database));
      expect(res.status).toBe(410);
    }
    for (const key of ["active",writeId]) {
      const res=await worker.fetch(new Request(`${base}/${key}`,{headers}),env(database));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(JSON.parse(JSON.stringify(stored)));
    }
  });

  it('stops consuming an oversized authenticated prepare body without Content-Length',async()=>{
    const database=new SqliteD1();
    installAuthorization();
    const cancel=vi.fn();
    const chunk=new Uint8Array(128*1024);
    const body=new ReadableStream({pull(controller){controller.enqueue(chunk);},cancel});
    const url='https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/prepare';
    const request=new Request(url,{method:'POST',headers:{authorization:'Bearer one-repository-token'},body,duplex:'half'} as RequestInit);
    const response=await worker.fetch(request,env(database));
    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['onboard-repository.yml','sync-review-instructions.yml'])('拒绝已退役来源 %s 的新正文意图',async workflow=>{
    const database=new SqliteD1();installAuthorization();
    const r=await worker.fetch(new Request('https://example.test/internal/issue-snapshots/1296724484/body-write-intents/42/prepare',{
      method:'POST',headers:{authorization:'Bearer one-repository-token','content-type':'application/json'},body:JSON.stringify({regionKind:'managed-pr',redrive:{workflow}})
    }),env(database));
    expect(r.status).toBe(410);
    expect(await new PullRequestBodyWriteIntentStore(database.binding()).get(1296724484,42)).toBeNull();
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

});
});
