import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyCopilotReviewState, copilotReviewTrigger, type CopilotReviewInput } from "../src/copilot-review-state.js";
import { configurationFor, ensureCopilotReview, main, reviewSyncMatrix } from "../src/index.js";
import { GitHubClient } from "../../github/src/index.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const head = "aed1c639a59ab76ac32b951abecc8c0e33082c13";
const priorHead = "c3a4c11bad79691c1a7bccb8e24376519f4c2e54";
const overview = "<!-- ccr-overview-v2 -->\n## Copilot review overview\n**Review effort:** Balanced\n**Findings:** 1";
const review = () => ({ id: 5404406878, user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: head, state: "COMMENTED", submitted_at: "2026-10-04T04:59:44Z", body: overview });
const check = () => ({ id: 111365108934, name: "copilot-pull-request-reviewer", app: { id: 15368 }, head_sha: head, status: "completed", conclusion: "success", started_at: "2026-10-04T04:51:03Z", completed_at: "2026-10-04T04:59:42Z", pull_requests: [{ number: 209, head: { sha: head } }] });
const input = (overrides: Partial<CopilotReviewInput> = {}): CopilotReviewInput => ({ pullRequestNumber: 209, headSha: head, requested: { users: [] }, reviews: [], events: [], checkRuns: [], ...overrides });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Copilot当前head审查证据", () => {
  it("历史quota COMMENTED不能成为成功证据", () => {
    const failed = { ...review(), id: 5404371151, commit_id: priorHead, submitted_at: "2026-10-04T04:46:11Z", body: "Copilot was unable to review: quota limit." };
    expect(classifyCopilotReviewState(input({ headSha: priorHead, reviews: [failed] })).state).toBe("failed-quota");
    expect(classifyCopilotReviewState(input({ reviews: [failed] })).state).toBe("none");
  });
  it("当前head成功概要和可信Check独立于发现处理", () => {
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [check()] }))).toMatchObject({ state: "succeeded", findings: 1, reviewId: 5404406878, checkRunId: 111365108934 });
  });
  it("成功后的新请求不能复用旧完成，绑定缺口保持unknown", () => {
    const event = { id: 12, event: "review_requested", requested_reviewer: { login: "copilot" }, created_at: "2026-10-04T05:00:00Z", commit_id: head };
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [check()], events: [event] })).state).toBe("queued");
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [check()], events: [{ ...event, commit_id: undefined }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [check()], events: [{ ...event, created_at: undefined }] })).state).toBe("unknown");
  });
  it("同一次尝试的终态冲突不能确认成功", () => {
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [check(), { ...check(), id: 2, conclusion: "failure" }] })).state).toBe("unknown");
  });
  it("成功Check缺失、未知Review格式或已撤销均保持unknown", () => {
    for (const body of [overview, "", "<!-- ccr-overview-v2 -->", "COMMENTED"]) expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), body }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), state: "DISMISSED" }], checkRuns: [check()] })).state).toBe("unknown");
  });
  it.each([
    { app: { id: 4243096 } }, { name: "fake" }, { head_sha: priorHead },
    { pull_requests: [] }, { pull_requests: [{ number: 210, head: { sha: head } }] },
    { pull_requests: [{ number: 209, head: { sha: priorHead } }] },
  ])("拒绝伪造或错误绑定的成功Check：%j", replacement => {
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [{ ...check(), ...replacement }] })).state).toBe("unknown");
  });
  it("queued与running不能冒充完成", () => {
    for (const status of ["queued", "in_progress"]) expect(classifyCopilotReviewState(input({ checkRuns: [{ ...check(), status }] })).state).toBe(status === "queued" ? "queued" : "running");
    expect(classifyCopilotReviewState(input({ requested: { users: [{ login: "copilot" }] } })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ afterEventId: 10, events: [{ id: 11, event: "review_requested", requested_reviewer: { login: "copilot" } }] })).state).toBe("queued");
  });
  it("旧事件不确认新请求，未知时间不能配对尝试", () => {
    expect(classifyCopilotReviewState(input({ afterEventId: 10, events: [{ id: 9, event: "review_requested", requested_reviewer: { login: "copilot" } }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), submitted_at: undefined }], checkRuns: [check()] })).state).toBe("unknown");
  });
  it("失败后的新active尝试报告运行中，不停留在旧失败", () => {
    const failed = { ...review(), body: "review failed", submitted_at: "2026-10-04T04:50:00Z" };
    expect(classifyCopilotReviewState(input({ reviews: [failed], checkRuns: [{ ...check(), status: "in_progress" }] })).state).toBe("running");
  });
  it.each(["permission denied", "review failed"])("保留明确失败诊断：%s", body => {
    expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), body }] })).state).toBe(body.includes("permission") ? "failed-permission" : "failed-other");
  });
  it("失败后新成功可以完成，成功后失败不能复用旧成功", () => {
    const failed = { ...review(), id: 1, submitted_at: "2026-10-04T04:50:00Z", body: "review failed" };
    expect(classifyCopilotReviewState(input({ reviews: [failed, review()], checkRuns: [check()] })).state).toBe("succeeded");
    expect(classifyCopilotReviewState(input({ reviews: [review(), { ...failed, submitted_at: "2026-10-04T05:00:00Z" }], checkRuns: [check()] })).state).toBe("failed-other");
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [check(), { ...check(), id: 2 }] })).state).toBe("unknown");
  });
});

describe("触发模式和令牌隔离", () => {
  it("批量规则同步按仓库拆分模式，保持默认接入和scope", () => {
    const registry = { organization: { id: 302208797, login: "splrad" }, defaults: { public: { managed: true }, private: { managed: false } }, repositories: {
      "1296724484": { fullName: "splrad/steward", managed: true, copilotReviewTrigger: "native" },
      "1296725317": { fullName: "splrad/.github", managed: true, copilotReviewTrigger: "legacy" },
    } };
    const repo = (id: number, name: string, privateRepo = false) => ({ id, full_name: `splrad/${name}`, private: privateRepo, owner: { id: 302208797, login: "splrad" } });
    const repositories = [repo(1296724484, "steward"), repo(1296725317, ".github"), repo(2, "new"), repo(3, "private", true)];
    expect(reviewSyncMatrix(registry, repositories)).toEqual({ include: [{ repositoryId: "2", trigger: "legacy" }, { repositoryId: "1296724484", trigger: "native" }, { repositoryId: "1296725317", trigger: "legacy" }] });
    expect(reviewSyncMatrix(registry, repositories, 1296724484)).toEqual({ include: [{ repositoryId: "1296724484", trigger: "native" }] });
    expect(() => reviewSyncMatrix(registry, repositories, 8)).toThrow("当前安装");
    expect(() => reviewSyncMatrix(registry, [repo(1296724484, "wrong")])).toThrow("不一致");
  });
  it("缺省legacy，仓库覆盖默认，非法模式与ID/name冲突失败", () => {
    const registry = { organization: { id: 1, login: "splrad" }, defaults: { public: { copilotReviewTrigger: "native" }, private: {} }, repositories: { "2": { fullName: "splrad/steward", copilotReviewTrigger: "legacy" } } };
    expect(copilotReviewTrigger(undefined)).toBe("legacy");
    expect(configurationFor(registry, { id: 2, full_name: "splrad/steward" }).copilotReviewTrigger).toBe("legacy");
    expect(configurationFor(registry, { id: 3, full_name: "splrad/other" }).copilotReviewTrigger).toBe("native");
    expect(() => configurationFor(registry, { id: 2, full_name: "wrong/steward" })).toThrow("不一致");
    expect(() => copilotReviewTrigger("invalid")).toThrow();
  });
  it.each(["none", "failed-quota", "unknown"])("native在%s下不读取请求令牌或调用请求API", async state => {
    vi.stubEnv("COPILOT_REVIEW_REQUEST_TOKEN", "");
    const gh = new GitHubClient("read-only");
    vi.spyOn(gh, "getRequestedReviewers").mockResolvedValue({ users: [] });
    vi.spyOn(gh, "listPullRequestReviews").mockResolvedValue(state === "none" ? [] : [{ ...review(), body: state === "failed-quota" ? "unable to review: quota limit" : "unknown" }]);
    vi.spyOn(gh, "listIssueEvents").mockResolvedValue([]);
    vi.spyOn(gh, "listAllCheckRuns").mockResolvedValue([]);
    const write = vi.spyOn(gh, "requestReviewers").mockRejectedValue(new Error("unexpected write"));
    expect(await ensureCopilotReview(gh, "splrad", "steward", 209, head, "b".repeat(40), "native")).toBe(`observed-${state}`);
    expect(write).not.toHaveBeenCalled();
  });
  it("legacy读取失败归unknown，不自动补发", async () => {
    const gh = new GitHubClient("read-only");
    vi.spyOn(gh, "getRequestedReviewers").mockRejectedValue(new Error("private error"));
    vi.spyOn(gh, "listPullRequestReviews").mockResolvedValue([]);
    vi.spyOn(gh, "listIssueEvents").mockResolvedValue([]);
    vi.spyOn(gh, "listAllCheckRuns").mockResolvedValue([]);
    expect(await ensureCopilotReview(gh, "splrad", "steward", 209, head, "b".repeat(40))).toBe("observed-unknown");
  });
  it("模式解析缺少输出或非法SHA时在授权客户端前拒绝", async () => {
    vi.stubEnv("GITHUB_OUTPUT", "");
    await expect(main(["review-trigger-mode", "--repository-id", "2", "--policy-sha", head])).rejects.toThrow("GITHUB_OUTPUT");
    vi.stubEnv("GITHUB_OUTPUT", "unused");
    await expect(main(["review-trigger-mode", "--repository-id", "2", "--policy-sha", "wrong"])).rejects.toThrow("40位");
  });
});

describe("工作流只读模式预检", () => {
  it("真实schema校验后输出单仓模式与混合矩阵，预检不请求审查", async () => {
    const directory = await mkdtemp(join(tmpdir(), "copilot-mode-preflight-"));
    const savedFetch = globalThis.fetch;
    try {
      await mkdir(join(directory, "config")); await mkdir(join(directory, "schema"));
      const registry = JSON.parse(await readFile("config/repositories.json", "utf8"));
      registry.repositories["1296724484"].copilotReviewTrigger = "native";
      await writeFile(join(directory, "config/repositories.json"), JSON.stringify(registry));
      await writeFile(join(directory, "schema/repositories.schema.json"), await readFile("schema/repositories.schema.json"));
      const target = join(directory, "output");
      vi.stubEnv("GITHUB_OUTPUT", target); vi.stubEnv("STEWARD_CONFIG_DIRECTORY", join(directory, "config"));
      vi.stubEnv("APP_ID", "4243096"); vi.stubEnv("INSTALLATION_ID", "145952003"); vi.stubEnv("SYNC_TRIGGER", "workflow_run");
      vi.stubEnv("STEWARD_APP_PRIVATE_KEY", generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } }).privateKey);
      const repositories = [{ id: 1296724484, full_name: "splrad/steward", owner: { id: 302208797, login: "splrad" }, private: false }, { id: 1296725317, full_name: "splrad/.github", owner: { id: 302208797, login: "splrad" }, private: false }];
      const writes: string[] = [];
      globalThis.fetch = vi.fn(async (input: any, init: RequestInit = {}) => {
        const url = String(input);
        if (init.method === "POST") {
          writes.push(url);
          expect(JSON.parse(String(init.body)).permissions).toEqual({ metadata: "read" });
          if (!url.endsWith("/access_tokens")) throw new Error("unexpected write");
          return new Response(JSON.stringify({ token: "test-installation-token" }), { status: 201 });
        }
        if (url.endsWith("/repositories/1296724484")) return new Response(JSON.stringify(repositories[0]));
        if (url.includes("/installation/repositories")) return new Response(JSON.stringify({ repositories }));
        throw new Error("unexpected endpoint");
      });
      await main(["review-trigger-mode", "--repository-id", "1296724484", "--policy-sha", head]);
      expect(await readFile(target, "utf8")).toBe("trigger=native\n");
      await main(["review-sync-targets", "--policy-sha", head]);
      expect(await readFile(target, "utf8")).toContain('matrix={"include":[{"repositoryId":"1296724484","trigger":"native"},{"repositoryId":"1296725317","trigger":"legacy"}]}');
      expect(writes).toHaveLength(2);
      registry.repositories["1296724484"].copilotReviewTrigger = "invalid";
      await writeFile(join(directory, "config/repositories.json"), JSON.stringify(registry));
      await expect(main(["review-trigger-mode", "--repository-id", "1296724484", "--policy-sha", head])).rejects.toThrow("schema");
      expect(writes).toHaveLength(2);
    } finally { globalThis.fetch = savedFetch; await rm(directory, { recursive: true, force: true }); }
  });
});
