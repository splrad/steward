import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyCopilotReviewState, copilotReviewTrigger, type CopilotReviewInput } from "../src/copilot-review-state.js";
import { configurationFor, ensureCopilotReview, main, readCopilotReviewState, reviewSyncMatrix } from "../src/index.js";
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
  it.each(["\n", "\r\n"])("无发现概要与可信Check配对后报告零发现：%j", newline => {
    const body = ["<!-- ccr-overview-v2 -->", "", "## Copilot review overview", "", "### 🔵 Needs a closer look", "", "仍需人工结合实际运行结果复核。", "", "**Review effort:** Balanced  ", "**Findings:** None", "", "<details>", "<summary><strong>Resolved since last review (2)</strong></summary>", "</details>"].join(newline);
    const base = { reviews: [{ ...review(), body }], checkRuns: [check()] };
    expect(classifyCopilotReviewState(input(base))).toMatchObject({ state: "succeeded", findings: 0, reviewId: review().id, checkRunId: check().id });
    expect(classifyCopilotReviewState(input({ ...base, checkRuns: [] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, checkRuns: [{ ...check(), conclusion: "failure" }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, reviews: [{ ...base.reviews[0], state: "DISMISSED" }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, headSha: priorHead })).state).toBe("none");
  });
  it.each(["None reported", "None yet", "none", "None1", "", "Unknown"])("未知发现字段不按零发现处理：%s", findings => {
    const body = overview.replace("**Findings:** 1", `**Findings:** ${findings}`);
    expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), body }], checkRuns: [check()] })).state).toBe("unknown");
  });
  it("无发现字段仍要求完整概要标识", () => {
    const body = overview.replace("**Findings:** 1", "**Findings:** None");
    for (const missing of ["<!-- ccr-overview-v2 -->", "## Copilot review overview", "**Review effort:** Balanced"]) {
      expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), body: body.replace(missing, "") }], checkRuns: [check()] })).state).toBe("unknown");
    }
  });
  it.each([head, null])("活动事件后的新概要不能复用已结束Check：%s", eventHead => {
    const event = { event: "copilot_work_started", commit_id: eventHead, created_at: "2026-10-04T05:00:00Z" };
    const base = { reviews: [{ ...review(), submitted_at: "2026-10-04T05:01:00Z" }], checkRuns: [check()], events: [event] };
    expect(classifyCopilotReviewState(input(base))).toMatchObject({ state: "unknown", reason: "activity-check-attempt-unverified" });
    expect(classifyCopilotReviewState(input({ ...base, events: [{ ...event, created_at: check().completed_at }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, events: [{ ...event, created_at: "2026-10-04T04:55:00Z" }] }))).toMatchObject({ state: "succeeded", findings: 1 });
    expect(classifyCopilotReviewState(input({ ...base, events: [{ ...event, commit_id: priorHead }] })).state).toBe("succeeded");
    const newer = { ...check(), id: 2, started_at: "2026-10-04T05:00:10Z", completed_at: "2026-10-04T05:00:59Z" };
    expect(classifyCopilotReviewState(input({ ...base, checkRuns: [check(), newer] }))).toMatchObject({ state: "succeeded", checkRunId: 2, findings: 1 });
  });
  it("Copilot读取全部Check分页并识别重叠尝试", async () => {
    const latest = { ...check(), id: 2, started_at: "2026-10-04T04:58:00Z" };
    const paths: URL[] = [];
    const gh = new GitHubClient("read-only", "https://example.test", (async (url: string) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/check-runs")) {
        paths.push(parsed);
        const second = parsed.searchParams.get("page") === "2";
        const next = new URL(parsed); next.searchParams.set("page", "2");
        return new Response(JSON.stringify({ check_runs: [second ? check() : latest] }), {
          status: 200, headers: second ? {} : { link: `<${next}>; rel="next"` },
        });
      }
      if (parsed.pathname.endsWith("/requested_reviewers")) return new Response(JSON.stringify({ users: [] }));
      if (parsed.pathname.endsWith("/reviews")) return new Response(JSON.stringify([review()]));
      if (parsed.pathname.endsWith("/events")) return new Response("[]");
      throw new Error("unexpected endpoint");
    }) as typeof fetch);
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [latest] })).state).toBe("succeeded");
    await expect(readCopilotReviewState(gh, "splrad", "steward", 209, head)).resolves.toMatchObject({ state: "unknown", reason: "overlapping-check-attempts" });
    expect(paths).toHaveLength(2);
    for (const path of paths) expect(path.searchParams.get("filter")).toBe("all");
  });
  it("历史quota COMMENTED不能成为成功证据", () => {
    const failed = { ...review(), id: 5404371151, commit_id: priorHead, submitted_at: "2026-10-04T04:46:11Z", body: "Copilot was unable to review: quota limit." };
    expect(classifyCopilotReviewState(input({ headSha: priorHead, reviews: [failed] })).state).toBe("failed-quota");
    expect(classifyCopilotReviewState(input({ reviews: [failed] })).state).toBe("none");
  });
  it("当前head成功概要和可信Check独立于发现处理", () => {
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [check()] }))).toMatchObject({ state: "succeeded", findings: 1, reviewId: 5404406878, checkRunId: 111365108934 });
  });
  it.each(["This PR fixes quota limit handling.", "permission denied", "review failed", "Copilot was unable to review this pull request because the user reached their quota limit.", "权限不足"])("成功概要讨论诊断文本时仍按可信完成证据判断：%s", text => {
    for (const body of [overview, "Copilot reviewed 2 out of 2 changed files in this pull request and generated 1 comment."]) {
      expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), body: `${body}\n\n${text}` }], checkRuns: [check()] }))).toMatchObject({ state: "succeeded", findings: 1 });
    }
  });
  it("真实quota诊断独立于审查发现文本", () => {
    expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), body: "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit." }] })).state).toBe("failed-quota");
    expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), body: "This PR fixes quota limit handling." }] })).state).toBe("unknown");
  });
  it("旧head已结束的历史请求不阻止新head审查", () => {
    const oldReview = { ...review(), commit_id: priorHead };
    const oldRequest = { id: 9, event: "review_requested", requested_reviewer: { login: "copilot" }, created_at: "2026-10-04T04:50:00Z", commit_id: null };
    const base = { reviews: [oldReview], events: [oldRequest] };
    expect(classifyCopilotReviewState(input(base)).state).toBe("none");
    const newRequest = { ...oldRequest, id: 11, created_at: "2026-10-04T05:00:00Z" };
    expect(classifyCopilotReviewState(input({ ...base, events: [oldRequest, { ...newRequest, commit_id: head }] })).state).toBe("queued");
    expect(classifyCopilotReviewState(input({ ...base, afterEventId: 10, events: [oldRequest, { ...newRequest, created_at: undefined }] })).state).toBe("queued");
    expect(classifyCopilotReviewState(input({ ...base, events: [oldRequest, newRequest] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, events: [{ ...oldRequest, created_at: undefined }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, reviews: [{ ...oldReview, submitted_at: undefined }] })).state).toBe("unknown");
  });
  it.each([false, true])("失败Check之后重新请求报告新尝试，历史Review=%s", withReview => {
    const failed = { ...check(), conclusion: "failure", started_at: "2026-10-04T04:58:00Z", completed_at: "2026-10-04T04:59:00Z" };
    const oldReview = { ...review(), submitted_at: "2026-10-04T04:57:00Z" };
    const event = { id: 12, event: "review_requested", requested_reviewer: { login: "copilot" }, created_at: "2026-10-04T05:00:00Z", commit_id: head };
    const base = { reviews: withReview ? [oldReview] : [], checkRuns: [failed] };
    expect(classifyCopilotReviewState(input({ ...base, events: [event] })).state).toBe("queued");
    expect(classifyCopilotReviewState(input({ ...base, events: [{ ...event, commit_id: undefined }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, events: [{ ...event, created_at: undefined }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, events: [{ ...event, created_at: failed.completed_at }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, events: [{ ...event, created_at: "2026-10-04T04:57:30Z" }] })).state).toBe("failed-other");
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
  it.each([head, null])("请求撤销后不报告排队，重新请求可开始新尝试：%s", removalHead => {
    const requested = { id: 10, event: "review_requested", requested_reviewer: { login: "copilot" }, commit_id: head, created_at: "2026-10-04T05:00:00Z" };
    const removed = { ...requested, id: 11, event: "review_request_removed", commit_id: removalHead, created_at: "2026-10-04T05:01:00Z" };
    const base = { reviews: [review()], checkRuns: [check()] };
    for (const events of [[requested, removed], [removed, requested]]) expect(classifyCopilotReviewState(input({ ...base, events }))).toMatchObject({ state: "unknown", reason: "request-removed" });
    expect(classifyCopilotReviewState(input({ events: [requested, removed] }))).toMatchObject({ state: "unknown", reason: "request-removed" });
    const retried = { ...requested, id: 12, created_at: "2026-10-04T05:02:00Z" };
    expect(classifyCopilotReviewState(input({ ...base, events: [removed, retried, requested] })).state).toBe("queued");
    expect(classifyCopilotReviewState(input({ ...base, events: [requested, { ...removed, created_at: requested.created_at }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, events: [requested, { ...removed, created_at: undefined }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, events: [requested, removed, { ...retried, event: "copilot_work_started" }] })).state).toBe("unknown");
    const laterCheck = { ...check(), id: 2, started_at: "2026-10-04T05:02:10Z", completed_at: "2026-10-04T05:03:00Z" };
    const laterReview = { ...review(), id: 2, submitted_at: "2026-10-04T05:03:01Z" };
    expect(classifyCopilotReviewState(input({ reviews: [review(), laterReview], checkRuns: [check(), laterCheck], events: [requested, removed, retried] }))).toMatchObject({ state: "succeeded", findings: 1 });
  });
  it.each(["other-reviewer", "other-head"])("无关撤销不覆盖Copilot请求：%s", kind => {
    const requested = { id: 10, event: "review_requested", requested_reviewer: { login: "copilot" }, commit_id: head, created_at: "2026-10-04T05:00:00Z" };
    const removed = { ...requested, id: 11, event: "review_request_removed", created_at: "2026-10-04T05:01:00Z", ...(kind === "other-reviewer" ? { requested_reviewer: { login: "other" } } : { commit_id: priorHead }) };
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [check()], events: [requested, removed] })).state).toBe("queued");
  });
  it("旧Check晚完成不覆盖其启动后的新请求或撤销", () => {
    const requested = { id: 10, event: "review_requested", requested_reviewer: { login: "copilot" }, commit_id: head, created_at: "2026-10-04T05:00:00Z" };
    const removed = { ...requested, id: 11, event: "review_request_removed", created_at: "2026-10-04T05:01:00Z" };
    const base = { reviews: [review()], checkRuns: [{ ...check(), completed_at: "2026-10-04T05:05:00Z" }] };
    expect(classifyCopilotReviewState(input({ ...base, events: [requested] })).state).toBe("queued");
    expect(classifyCopilotReviewState(input({ ...base, events: [requested, removed] }))).toMatchObject({ state: "unknown", reason: "request-removed" });
  });
  it("活动事件不把已知运行中的Check降为排队", () => {
    expect(classifyCopilotReviewState(input({ checkRuns: [{ ...check(), status: "in_progress" }], events: [{ event: "copilot_work_started", commit_id: head, created_at: "2026-10-04T04:52:00Z" }] })).state).toBe("running");
  });
  it.each([head, null])("重新请求是概要配对边界，不能复用旧Check：%s", requestHead => {
    const requested = { id: 10, event: "review_requested", requested_reviewer: { login: "copilot" }, commit_id: requestHead, created_at: "2026-10-04T05:00:00Z" };
    const laterReview = { ...review(), submitted_at: "2026-10-04T05:01:00Z" };
    const base = { reviews: [laterReview], checkRuns: [check()], events: [requested] };
    expect(classifyCopilotReviewState(input(base))).toMatchObject({ state: "unknown", reason: "review-check-attempt-unverified" });
    const laterCheck = { ...check(), id: 2, started_at: "2026-10-04T05:00:10Z", completed_at: "2026-10-04T05:00:59Z" };
    expect(classifyCopilotReviewState(input({ ...base, checkRuns: [check(), laterCheck] }))).toMatchObject({ state: "succeeded", findings: 1, checkRunId: 2 });
    expect(classifyCopilotReviewState(input({ ...base, checkRuns: [check(), { ...laterCheck, started_at: requested.created_at }] })).state).toBe("unknown");
    expect(classifyCopilotReviewState(input({ ...base, events: [{ ...requested, event: "review_request_removed" }] })).state).toBe("unknown");
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
  it.each(["check", "review", "both"])("新成功Check缺少Review时不复用旧失败：%s", source => {
    const failedCheck = { ...check(), id: 1, conclusion: "failure", started_at: "2026-10-04T04:40:00Z", completed_at: "2026-10-04T04:45:00Z" };
    const failedReview = { ...review(), id: 2, body: "Copilot was unable to review: quota limit.", submitted_at: "2026-10-04T04:46:00Z" };
    const reviews = source === "check" ? [] : [failedReview];
    const checks = source === "review" ? [check()] : [failedCheck, check()];
    for (const checkRuns of [checks, [...checks].reverse()]) expect(classifyCopilotReviewState(input({ reviews, checkRuns }))).toMatchObject({ state: "unknown", reason: "check-without-current-review", checkRunId: check().id });
  });
  it.each(["failure", "success"])("较新成功Review与Check排除已结束的历史Check：%s", conclusion => {
    const prior = { ...check(), id: 1, conclusion, started_at: "2026-10-04T04:40:00Z", completed_at: "2026-10-04T04:45:00Z" };
    for (const checkRuns of [[prior, check()], [check(), prior]]) expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns }))).toMatchObject({ state: "succeeded", findings: 1, reviewId: review().id, checkRunId: check().id });
  });
  it.each(["2026-10-04T04:51:03Z", "2026-10-04T04:55:00Z"])("旧失败与新尝试同时间或重叠时保留unknown：%s", completed_at => {
    const prior = { ...check(), id: 1, conclusion: "failure", started_at: "2026-10-04T04:40:00Z", completed_at };
    expect(classifyCopilotReviewState(input({ reviews: [review()], checkRuns: [prior, check()] })).state).toBe("unknown");
  });
  it.each(["queued", "in_progress", "failure"])("只采用较新的可信尝试状态：%s", outcome => {
    const prior = { ...check(), id: 1, started_at: "2026-10-04T04:40:00Z", completed_at: "2026-10-04T04:45:00Z" };
    const priorReview = { ...review(), submitted_at: "2026-10-04T04:46:00Z" };
    const newer = { ...check(), status: outcome === "failure" ? "completed" : outcome, conclusion: outcome === "failure" ? "failure" : null };
    expect(classifyCopilotReviewState(input({ reviews: [priorReview], checkRuns: [prior, newer] })).state).toBe(outcome === "failure" ? "failed-other" : outcome === "queued" ? "queued" : "running");
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
