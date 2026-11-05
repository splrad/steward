import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyCopilotReviewState, type CopilotReviewInput } from "../src/copilot-review-state.js";
import { readCopilotReviewState } from "../src/index.js";
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
  it.each([['**0 open findings**', 0], ['<summary><strong>1 open finding</strong></summary>', 1], ['<summary><strong>12 open findings</strong></summary>', 12]])("识别新版未解决发现统计：%s", (count, findings) => {
    const body = `<!-- ccr-overview-v2 -->\n### 🟢 Approval recommended\n${count}\n🧠 **Review effort:** Balanced\n<details>\n<summary><strong>Resolved since last review (3)</strong></summary>\n</details>`;
    expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), body }], checkRuns: [check()] }))).toMatchObject({ state: "succeeded", findings });
    for (const malformed of [body.replace('<!-- ccr-overview-v2 -->', ''), body.replace('**Review effort:** Balanced', ''), body + '\n**9 open findings**']) {
      expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), body: malformed }], checkRuns: [check()] })).state).toBe('unknown');
    }
  });
  it("保留旧版数字字段后附说明的兼容性", () => {
    expect(classifyCopilotReviewState(input({ reviews: [{ ...review(), body: overview + " (1 open finding)" }], checkRuns: [check()] }))).toMatchObject({ state: "succeeded", findings: 1 });
  });
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
    const gh = new GitHubClient("read-only", "https://api.github.com", (async (url: string) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/check-runs")) {
        paths.push(parsed);
        const second = parsed.searchParams.get("page") === "2";
        const next = new URL(parsed); next.searchParams.set("page", "2");
        return nativeResponse(url,{ check_runs: [second ? check() : latest] }, {
          status: 200, headers: second ? {} : { link: `<${next}>; rel="next"` },
        });
      }
      if (parsed.pathname.endsWith("/requested_reviewers")) return nativeResponse(url,{ users: [] });
      if (parsed.pathname.endsWith("/reviews")) return nativeResponse(url,[review()]);
      if (parsed.pathname.endsWith("/events")) return nativeResponse(url,[]);
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


function nativeResponse(url:unknown,value:unknown,init:ResponseInit={}){const response=Response.json(value,init);Object.defineProperty(response,'url',{value:String(url)});return response;}
