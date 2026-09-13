import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, isDependabotReviewEligible } from "../../github/src/index.js";
import { isTrustedReviewRequestSource, main, parseInvocation, requestDependabotCopilotReview } from "../src/index.js";

const head = "a".repeat(40);
const policy = "b".repeat(40);
const repository = () => ({ id: 1296724484, full_name: "splrad/steward", owner: { id: 302208797 }, private: false, fork: false, archived: false, disabled: false, default_branch: "main" });
const pull = () => ({ number: 187, state: "open", draft: false, user: { id: 49699333, login: "dependabot[bot]", type: "Bot" }, base: { ref: "main", repo: { id: 1296724484 } }, head: { sha: head, repo: { id: 1296724484 } } });
const context = () => ({ TRIGGER_ACTOR_ID: "301115370", WORKFLOW_REPOSITORY: "splrad/steward", WORKFLOW_EVENT: "workflow_dispatch", WORKFLOW_RUN_REF: "refs/heads/main", WORKFLOW_REF: "splrad/steward/.github/workflows/pr-automation.yml@refs/heads/main", WORKFLOW_DEFAULT_BRANCH: "main", WORKFLOW_SHA: policy });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Dependabot审查范围", () => {
  it.each([1296724484, 1187527897])("允许两个目标仓库的官方Dependabot同仓Ready PR：%i", id => {
    const r = repository(); r.id = id; r.full_name = id === 1296724484 ? "splrad/steward" : "splrad/LayerScape";
    const p = pull(); p.base.repo.id = id; p.head.repo.id = id;
    expect(isDependabotReviewEligible(r, p, head)).toBe(true);
  });
  it.each([
    ["draft", (r: any, p: any) => { p.draft = true; }],
    ["closed", (r: any, p: any) => { p.state = "closed"; }],
    ["fork", (r: any, p: any) => { p.head.repo.id = 123; }],
    ["base", (r: any, p: any) => { p.base.ref = "release"; }],
    ["base repo", (r: any, p: any) => { p.base.repo.id = 123; }],
    ["head", (r: any, p: any) => { p.head.sha = "c".repeat(40); }],
    ["id", (r: any, p: any) => { p.user.id = 1; }],
    ["login", (r: any, p: any) => { p.user.login = "other[bot]"; }],
    ["type", (r: any, p: any) => { p.user.type = "User"; }],
    ["private", (r: any) => { r.private = true; }],
    ["archived", (r: any) => { r.archived = true; }],
    ["disabled", (r: any) => { r.disabled = true; }],
    ["renamed", (r: any) => { r.full_name = "other/steward"; }],
    ["owner", (r: any) => { r.owner.id = 1; }],
    ["unregistered", (r: any) => { r.id = 1; }],
  ])("拒绝不适用对象：%s", (_label, mutate) => {
    const r = repository(); const p = pull(); mutate(r, p);
    expect(isDependabotReviewEligible(r, p, head)).toBe(false);
  });
  it("校验dispatch来源及命令参数", async () => {
    expect(isTrustedReviewRequestSource(policy, context())).toBe(true);
    for (const key of Object.keys(context())) expect(isTrustedReviewRequestSource(policy, { ...context(), [key]: "wrong" })).toBe(false);
    expect(parseInvocation(["request-copilot-review", "--event-head-sha", head]).args["event-head-sha"]).toBe(head);
    await expect(main(["request-copilot-review", "--policy-sha", policy])).rejects.toThrow("来源不可信");
  });
});

function fixture(options: { reviews?: any[]; active?: boolean; pending?: boolean; driftAt?: number; archivedAt?: number; requestStatus?: number; noEvent?: boolean; unreadableReviews?: boolean } = {}) {
  const writes: string[] = []; let requested = false; let pullReads = 0; let repositoryReads = 0;
  vi.stubEnv("COPILOT_REVIEW_REQUEST_TOKEN", "review-token");
  vi.stubGlobal("fetch", async (input: any, init: RequestInit = {}) => {
    const url = String(input); const method = init.method ?? "GET";
    if (method !== "GET") writes.push(`${method} ${url}`);
    const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.endsWith("/repositories/1296724484")) { repositoryReads++; const r = repository(); if (options.archivedAt && repositoryReads >= options.archivedAt) r.archived = true; return ok(r); }
    if (url.endsWith("/pulls/187")) { pullReads++; const p = pull(); if (options.driftAt && pullReads >= options.driftAt) p.head.sha = "c".repeat(40); return ok(p); }
    if (url.endsWith("/requested_reviewers")) {
      if (method === "POST") { requested = true; return options.requestStatus ? new Response("denied", { status: options.requestStatus }) : ok({}); }
      return ok({ users: options.pending ? [{ login: "copilot-pull-request-reviewer[bot]" }] : [] });
    }
    if (url.includes("/reviews?")) return options.unreadableReviews ? new Response("unavailable", { status: 403 }) : ok(options.reviews ?? []);
    if (url.includes("/events?")) return ok(requested && !options.noEvent ? [{ id: 2, event: "review_requested", requested_reviewer: { login: "copilot-pull-request-reviewer[bot]" } }] : [{ id: 1, event: "opened" }]);
    if (url.includes("/check-runs?")) return ok({ check_runs: options.active ? [{ name: "copilot-pull-request-reviewer", app: { id: 15368 }, head_sha: head, status: "in_progress", pull_requests: [{ number: 187, head: { sha: head } }] }] : [] });
    throw new Error(`unexpected endpoint: ${method} ${url}`);
  });
  return { writes, run: (managed = true) => requestDependabotCopilotReview(new GitHubClient("read-token", "https://api.github.com", fetch, policy), 1296724484, 187, head, policy, () => managed) };
}

describe("Dependabot审查请求", () => {
  it("首次请求仅写入reviewer并读回新事件", async () => {
    const f = fixture(); expect(await f.run()).toBe("requested-and-confirmed");
    expect(f.writes).toEqual(["POST https://api.github.com/repos/splrad/steward/pulls/187/requested_reviewers"]);
  });
  it("同head完成记录抑制重复请求", async () => {
    const f = fixture({ reviews: [{ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: head, state: "COMMENTED" }] });
    expect(await f.run()).toBe("already-present"); expect(f.writes).toEqual([]);
  });
  it("同head活动Check抑制重复请求", async () => {
    const f = fixture({ active: true }); expect(await f.run()).toBe("already-present"); expect(f.writes).toEqual([]);
  });
  it("旧head和pending reviewer不冒充新head审查", async () => {
    const f = fixture({ pending: true, reviews: [{ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "d".repeat(40), state: "COMMENTED" }] });
    expect(await f.run()).toBe("requested-and-confirmed"); expect(f.writes).toHaveLength(1);
  });
  it("已撤销Review不能抑制新请求", async () => {
    const f = fixture({ reviews: [{ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: head, state: "DISMISSED" }] });
    expect(await f.run()).toBe("requested-and-confirmed"); expect(f.writes).toHaveLength(1);
  });
  it("旧事件和未受管仓库没有写入", async () => {
    const f = fixture({ driftAt: 1 }); expect(await f.run()).toBe("ignored-or-stale"); expect(f.writes).toEqual([]);
    const g = fixture(); expect(await g.run(false)).toBe("ignored"); expect(g.writes).toEqual([]);
  });
  it("请求前head变化时中止写入", async () => {
    const f = fixture({ driftAt: 2 }); await expect(f.run()).rejects.toThrow("请求前PR或仓库状态已变化"); expect(f.writes).toEqual([]);
  });
  it("请求期间head变化不报告当前提交已确认", async () => {
    const f = fixture({ driftAt: 3 }); expect(await f.run()).toBe("changed-during-request"); expect(f.writes).toHaveLength(1);
  });
  it("请求前仓库归档时中止", async () => {
    const f = fixture({ archivedAt: 2 }); await expect(f.run()).rejects.toThrow("请求前PR或仓库状态已变化"); expect(f.writes).toEqual([]);
  });
  it("请求被拒绝时显式失败", async () => {
    const f = fixture({ requestStatus: 403 }); await expect(f.run()).rejects.toThrow(); expect(f.writes).toHaveLength(1);
  });
  it("Review读取失败时不发请求", async () => {
    const f = fixture({ unreadableReviews: true }); await expect(f.run()).rejects.toThrow(); expect(f.writes).toEqual([]);
  });
  it("只有pending但没有新事件时保留未确认状态", async () => {
    const f = fixture({ pending: true, noEvent: true });
    expect(await f.run()).toBe("requested-unconfirmed"); expect(f.writes).toHaveLength(1);
  }, 15000);
  it("同head重复请求没有新增事件时不误报确认或失败", async () => {
    const f = fixture({ pending: true });
    expect(await f.run()).toBe("requested-and-confirmed");
    expect(await f.run()).toBe("requested-unconfirmed"); expect(f.writes).toHaveLength(2);
  }, 15000);
  it("未确认请求之后head变化仍报告版本变化", async () => {
    const f = fixture({ pending: true, noEvent: true, driftAt: 3 });
    expect(await f.run()).toBe("changed-during-request");
  }, 15000);
});
