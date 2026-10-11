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

function fixture(options: { reviews?: any[]; active?: boolean; completed?: boolean; pending?: boolean; driftAt?: number; archivedAt?: number; unreadableReviews?: boolean } = {}) {
  const writes: string[] = []; let pullReads = 0; let repositoryReads = 0;
  vi.stubEnv("COPILOT_REVIEW_REQUEST_TOKEN", "review-token");
  vi.stubGlobal("fetch", async (input: any, init: RequestInit = {}) => {
    const url = String(input); const method = init.method ?? "GET";
    if (method !== "GET") writes.push(`${method} ${url}`);
    const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.endsWith("/repositories/1296724484")) { repositoryReads++; const r = repository(); if (options.archivedAt && repositoryReads >= options.archivedAt) r.archived = true; return ok(r); }
    if (url.endsWith("/pulls/187")) { pullReads++; const p = pull(); if (options.driftAt && pullReads >= options.driftAt) p.head.sha = "c".repeat(40); return ok(p); }
    if (url.endsWith("/requested_reviewers")) {
      return ok({ users: options.pending ? [{ login: "copilot-pull-request-reviewer[bot]" }] : [] });
    }
    if (url.includes("/reviews?")) return options.unreadableReviews ? new Response("unavailable", { status: 403 }) : ok((options.reviews ?? []).map(review => ({ id: 1, submitted_at: "2026-10-04T04:59:44Z", ...review })));
    if (url.includes("/events?")) return ok([{ id: 1, event: "opened" }]);
    if (url.includes("/check-runs?")) return ok({ check_runs: options.active || options.completed ? [{ id: 1, name: "copilot-pull-request-reviewer", app: { id: 15368 }, head_sha: head, status: options.active ? "in_progress" : "completed", conclusion: "success", started_at: "2026-10-04T04:51:03Z", completed_at: "2026-10-04T04:59:42Z", pull_requests: [{ number: 187, head: { sha: head } }] }] : [] });
    throw new Error(`unexpected endpoint: ${method} ${url}`);
  });
  return { writes, run: (managed = true, trigger: "native" = "native") => requestDependabotCopilotReview(new GitHubClient("read-token", "https://api.github.com", fetch, policy), 1296724484, 187, head, policy, () => managed, trigger) };
}

describe("Dependabot审查观察", () => {
  it("无审查证据时保持只读", async () => {
    const f = fixture(); expect(await f.run()).toBe("observed-none");
    expect(f.writes).toEqual([]);
  });
  it("同head完成记录抑制重复请求", async () => {
    const f = fixture({ completed: true, reviews: [{ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: head, state: "COMMENTED", body: "Copilot reviewed 2 out of 2 changed files in this pull request and generated 0 comments." }] });
    expect(await f.run()).toBe("observed-succeeded"); expect(f.writes).toEqual([]);
  });
  it("同head活动Check抑制重复请求", async () => {
    const f = fixture({ active: true }); expect(await f.run()).toBe("observed-running"); expect(f.writes).toEqual([]);
  });
  it("旧head和pending reviewer不冒充新head审查", async () => {
    const f = fixture({ pending: true, reviews: [{ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "d".repeat(40), state: "COMMENTED" }] });
    expect(await f.run()).toBe("observed-unknown"); expect(f.writes).toHaveLength(0);
  });
  it("已撤销Review保留unknown，不自动补发", async () => {
    const f = fixture({ reviews: [{ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: head, state: "DISMISSED" }] });
    expect(await f.run()).toBe("observed-unknown"); expect(f.writes).toHaveLength(0);
  });
  it("旧事件和未受管仓库没有写入", async () => {
    const f = fixture({ driftAt: 1 }); expect(await f.run()).toBe("ignored-or-stale"); expect(f.writes).toEqual([]);
    const g = fixture(); expect(await g.run(false)).toBe("ignored"); expect(g.writes).toEqual([]);
  });
  it("观察期间head变化不复用旧结果", async () => {
    const f = fixture({ driftAt: 2 }); expect(await f.run()).toBe("changed-during-request"); expect(f.writes).toHaveLength(0);
  });
  it("观察期间仓库归档时返回变化状态", async () => {
    const f = fixture({ archivedAt: 2 }); expect(await f.run()).toBe("changed-during-request"); expect(f.writes).toEqual([]);
  });
  it("Review读取失败时不发请求", async () => {
    const f = fixture({ unreadableReviews: true }); expect(await f.run()).toBe("observed-unknown"); expect(f.writes).toEqual([]);
  });
  it("只有pending但没有新事件时保留未确认状态", async () => {
    const f = fixture({ pending: true });
    expect(await f.run()).toBe("observed-unknown"); expect(f.writes).toHaveLength(0);
  }, 15000);
  it("同head重复观察保持无证据状态", async () => {
    const f = fixture();
    expect(await f.run()).toBe("observed-none");
    expect(await f.run()).toBe("observed-none"); expect(f.writes).toHaveLength(0);
  }, 15000);
  it("native保持资格核验，只读观察且不依赖请求令牌", async () => {
    const f = fixture(); vi.stubEnv("COPILOT_REVIEW_REQUEST_TOKEN", "");
    expect(await f.run(true, "native")).toBe("observed-none"); expect(f.writes).toEqual([]);
  });
  it("省略触发模式时同样只读观察", async () => {
    const f = fixture(); vi.stubEnv("COPILOT_REVIEW_REQUEST_TOKEN", "");
    expect(await requestDependabotCopilotReview(new GitHubClient("read-token", "https://api.github.com", fetch, policy), 1296724484, 187, head, policy, () => true)).toBe("observed-none");
    expect(f.writes).toEqual([]);
  });
  it("quota失败在重复派发下不自动重试", async () => {
    const f = fixture({ reviews: [{ user: { login: "copilot" }, commit_id: head, state: "COMMENTED", body: "unable to review: quota limit" }] });
    expect(await f.run()).toBe("observed-failed-quota"); expect(await f.run()).toBe("observed-failed-quota"); expect(f.writes).toEqual([]);
  });
});
