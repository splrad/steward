import { describe, expect, it } from "vitest";
import { GitHubClient } from "../../github/src/index.js";
import { classifyCopilotReviewState } from "../src/copilot-review-state.js";
import { forkCheckFor, readForkCopilotEvidence, type ForkCopilotEvidence } from "../src/copilot-fork-evidence.js";
import { readCopilotReviewState } from "../src/index.js";

const head = "671cbcf3a941303f8fcefafca138ff7f72f283c8";
const base = "10dee839b32d3f1d049898cf0dd5c9b883fe6221";
const repository = { id: 1296724484, full_name: "splrad/steward" };
const runId = 37944725166, jobId = 113867939753;
const since = "2026-10-09T14:30:40.000Z";
const pull = { number: 224, created_at: "2026-10-09T14:00:00Z", base: { repo: repository }, head: { sha: head, repo: { id: 1408639960 } } };
const review = { id: 5471447023, user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: head, state: "COMMENTED", submitted_at: "2026-10-09T14:31:45Z", body: "<!-- ccr-overview-v2 -->\n### 🟢 Approval recommended\n**0 open findings**\n🧠 **Review effort:** Balanced" };
const event = { event: "review_requested", requested_reviewer: { login: "copilot-pull-request-reviewer[bot]" }, created_at: since };
function fixture(): ForkCopilotEvidence {
  const bot = { id: 175728472, login: "Copilot", type: "Bot" };
  const check = { id: jobId, name: "copilot-pull-request-reviewer", app: { id: 15368 }, check_suite: { id: 102809311535 }, head_sha: base, status: "completed", conclusion: "success", started_at: "2026-10-09T14:30:52Z", completed_at: "2026-10-09T14:31:46Z", pull_requests: [] };
  return {
    repository: repository.full_name, repositoryId: repository.id,
    check,
    run: { id: runId, run_attempt: 1, event: "dynamic", path: "dynamic/agents/copilot-pull-request-reviewer", head_sha: base, status: "completed", conclusion: "success", check_suite_id: check.check_suite.id, created_at: "2026-10-09T14:30:46Z", updated_at: "2026-10-09T14:31:47Z", repository, head_repository: repository, actor: bot, triggering_actor: bot, pull_requests: [] },
    job: { id: jobId, run_id: runId, run_attempt: 1, head_sha: base, name: check.name, status: check.status, conclusion: check.conclusion, started_at: check.started_at, completed_at: check.completed_at, check_run_url: `https://api.github.com/repos/splrad/steward/check-runs/${jobId}`, steps: [{ name: "Processing Request (Linux)", status: "completed", conclusion: "success", started_at: "2026-10-09T14:31:12Z", completed_at: "2026-10-09T14:31:42Z" }] },
    log: `2026-10-09T14:31:16.9709133Z Analyzing splrad/steward PR #224, request-id 70DF:376953:9E865:B6B1B:6AC8FA8E (autofind.js version: 0.1.150)\n2026-10-09T14:31:17.9422354Z Fetching diff ${base}...${head} for splrad/steward\n2026-10-09T14:31:17.9994120Z Checking out splrad/steward at SHA ${head} into /workspace/steward\n`,
  };
}
const classify = (proof: ForkCopilotEvidence) => classifyCopilotReviewState({ pullRequestNumber: 224, headSha: head, requested: { users: [] }, reviews: [review], events: [event], checkRuns: [], forkEvidence: [proof] });
function client(proofs = [fixture()], override?: (path: string, count: number) => unknown) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const gh = new GitHubClient("test-token", "https://api.github.com", (async (url: string, init: RequestInit) => {
    expect(init.method ?? "GET").toBe("GET");
    const parsed = new URL(url), path = parsed.pathname;
    calls.push(path); const count = (counts.get(path) ?? 0) + 1; counts.set(path, count);
    const replacement = override?.(path, count);
    if (replacement instanceof Error) throw replacement;
    let value: unknown = replacement;
    if (value === undefined) {
      if (path.endsWith('/requested_reviewers')) value = { users: [] };
      else if (path.endsWith('/reviews')) value = [review];
      else if (path.endsWith('/events')) value = [event];
      else if (path.includes('/commits/')) value = { check_runs: [] };
      else if (path.endsWith('/pulls/224')) value = pull;
      else if (path.endsWith('/actions/runs')) {
        const created = parsed.searchParams.get('created');
        const runs = proofs.map(proof => proof.run).filter(run => !created || Date.parse(run.created_at) >= Date.parse(created.slice(2)));
        value = { total_count: runs.length, workflow_runs: runs };
      }
      else {
        const proof = proofs.find(proof => path.includes(`/runs/${proof.run.id}/`) || path.includes(`/jobs/${proof.job.id}/`) || path.endsWith(`/check-runs/${proof.check.id}`));
        if (!proof) throw new Error(`未知测试端点 ${path}`);
        if (path.endsWith('/jobs')) value = { jobs: [proof.job] };
        else if (path.endsWith('/logs')) return new Response(proof.log);
        else value = proof.check;
      }
    }
    return new Response(JSON.stringify(value));
  }) as typeof fetch);
  return { gh, calls };
}

describe("fork Copilot运行证据", () => {
  it("使用真实运行字段关联当前head并保留原始Check SHA", async () => {
    const proof = fixture();
    expect(forkCheckFor(proof, 224, head)).toBe(proof.check);
    expect(classify(proof)).toMatchObject({ state: "succeeded", findings: 0, checkRunId: jobId, reviewId: review.id });
    const { gh } = client();
    await expect(readCopilotReviewState(gh, "splrad", "steward", 224, head)).resolves.toMatchObject({ state: "succeeded", findings: 0 });
    expect(proof.check.head_sha).toBe(base);
  });
  it.each([
    ['错误PR', (p: ForkCopilotEvidence) => { p.log = p.log.replace('#224', '#223'); }],
    ['错误head', (p: ForkCopilotEvidence) => { p.log = p.log.replaceAll(head, 'f'.repeat(40)); }],
    ['错误base', (p: ForkCopilotEvidence) => { p.log = p.log.replace(base, 'e'.repeat(40)); }],
    ['同名用户', (p: ForkCopilotEvidence) => { p.run.actor = { ...p.run.actor, id: 1 }; }],
    ['普通工作流', (p: ForkCopilotEvidence) => { p.run.event = 'push'; }],
    ['错误仓库', (p: ForkCopilotEvidence) => { p.repositoryId = 1; }],
    ['错误job', (p: ForkCopilotEvidence) => { p.job.run_id = 1; }],
    ['重试不一致', (p: ForkCopilotEvidence) => { p.run.run_attempt = 2; }],
    ['错误Check套件', (p: ForkCopilotEvidence) => { p.check.check_suite.id = 1; }],
    ['错误Check应用', (p: ForkCopilotEvidence) => { p.check.app.id = 1; }],
    ['错误job链接', (p: ForkCopilotEvidence) => { p.job.check_run_url += '?x=1'; }],
    ['缺少检出', (p: ForkCopilotEvidence) => { p.log = p.log.split('\n').slice(0, 2).join('\n'); }],
    ['重复关联', (p: ForkCopilotEvidence) => { p.log = p.log.split('\n')[0] + '\n' + p.log; }],
    ['步骤范围外', (p: ForkCopilotEvidence) => { p.job.steps[0].started_at = '2026-10-09T14:31:18Z'; }],
    ['日志晚于步骤', (p: ForkCopilotEvidence) => { p.log = p.log.replaceAll('14:31:17.', '14:31:43.'); }],
    ['检出后伪造', (p: ForkCopilotEvidence) => { p.log = `2026-10-09T14:31:13.000Z Checking out splrad/steward at SHA ${base} into /workspace/steward\n` + p.log; }],
    ['失败状态冲突', (p: ForkCopilotEvidence) => { p.run.conclusion = 'failure'; }],
  ] as const)("拒绝%s", (_, change) => {
    const proof = fixture(); change(proof);
    expect(forkCheckFor(proof, 224, head)).toBeUndefined();
    expect(classify(proof).state).toBe('unknown');
  });
  it("共享base上的其他PR有独立运行", async () => {
    const other = fixture(); other.run.id++; other.job.id++; other.check.id++;
    other.job.run_id = other.run.id; other.job.check_run_url = `https://api.github.com/repos/splrad/steward/check-runs/${other.check.id}`;
    other.log = other.log.replace('#224', '#223');
    const { gh } = client([other, fixture()]);
    const proofs = await readForkCopilotEvidence(gh, 'splrad', 'steward', 224, head, since);
    expect(proofs).toHaveLength(1); expect(proofs[0]?.check.id).toBe(jobId);
  });
  it.each(['日志丢失', '新运行', '重试变化', 'head变化', '事件变化', '运行未结束'])("读取期间%s保持unknown", async kind => {
    const { gh } = client([fixture()], (path, count) => {
      if (kind === '日志丢失' && path.endsWith('/logs')) return new Error('404');
      if (kind === 'head变化' && path.endsWith('/pulls/224') && count === 2) return { ...pull, head: { ...pull.head, sha: base } };
      if (kind === '事件变化' && path.endsWith('/events') && count === 2) return [event, { ...event, created_at: '2026-10-09T14:32:00Z' }];
      if (path.endsWith('/actions/runs')) {
        if (kind === '运行未结束') return { total_count: 1, workflow_runs: [{ ...fixture().run, status: 'in_progress' }] };
        if (count === 2 && kind === '重试变化') return { total_count: 1, workflow_runs: [{ ...fixture().run, run_attempt: 2 }] };
        if (count === 2 && kind === '新运行') return { total_count: 2, workflow_runs: [fixture().run, { ...fixture().run, id: runId + 1 }] };
      }
      return undefined;
    });
    await expect(readCopilotReviewState(gh, 'splrad', 'steward', 224, head)).resolves.toMatchObject({ state: 'unknown' });
  });
  it("新请求之前启动且尚未结束的旧尝试不会被查询边界遗漏", async () => {
    const prior = fixture(); prior.run.id++; prior.job.id++; prior.check.id++;
    prior.job.run_id = prior.run.id; prior.job.check_run_url = `https://api.github.com/repos/splrad/steward/check-runs/${prior.check.id}`;
    prior.run.created_at = '2026-10-09T14:29:10Z';
    prior.job.started_at = prior.check.started_at = '2026-10-09T14:29:20Z';
    const { gh } = client([prior, fixture()]);
    const proofs = await readForkCopilotEvidence(gh, 'splrad', 'steward', 224, head, since);
    expect(classifyCopilotReviewState({ pullRequestNumber: 224, headSha: head, requested: { users: [] }, reviews: [review], events: [event], checkRuns: [], forkEvidence: proofs })).toMatchObject({ state: 'unknown', reason: 'overlapping-check-attempts' });
  });
  it("新请求前已结束的旧运行不再下载日志", async () => {
    const old = fixture(); old.run.id++; old.run.updated_at = '2026-10-09T14:29:00Z';
    const { gh, calls } = client([old, fixture()]);
    await expect(readForkCopilotEvidence(gh, 'splrad', 'steward', 224, head, since)).resolves.toHaveLength(1);
    expect(calls.some(path => path.includes(`/runs/${old.run.id}/`))).toBe(false);
  });
  it("PR创建前超过1000条历史运行不影响当前审查", async () => {
    const history = Array.from({ length: 1000 }, (_, index) => {
      const old = fixture();
      old.run.id = index + 1;
      old.run.created_at = '2026-10-08T00:00:00Z';
      old.run.updated_at = '2026-10-08T00:01:00Z';
      return old;
    });
    const { gh } = client([...history, fixture()]);
    await expect(readCopilotReviewState(gh, 'splrad', 'steward', 224, head)).resolves.toMatchObject({ state: 'succeeded' });
  });
  it.each([undefined, 'invalid', '2026-10-09T14:31:00Z'])("PR创建时间无效时保持unknown：%s", async created_at => {
    const { gh } = client([fixture()], path => path.endsWith('/pulls/224') ? { ...pull, created_at } : undefined);
    await expect(readCopilotReviewState(gh, 'splrad', 'steward', 224, head)).resolves.toMatchObject({ state: 'unknown' });
  });
  it("查询满上限不消费截断结果", async () => {
    const { gh } = client([fixture()], path => path.endsWith('/actions/runs') ? { total_count: 1000, workflow_runs: [fixture().run] } : undefined);
    await expect(readCopilotReviewState(gh, 'splrad', 'steward', 224, head)).resolves.toMatchObject({ state: 'unknown' });
  });
});
