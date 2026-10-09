import type { GitHubClient } from "../../github/src/index.js";

type RecordValue = { [key: string]: any };
export interface ForkCopilotEvidence {
  repository: string;
  repositoryId: number;
  run: RecordValue;
  job: RecordValue;
  check: RecordValue;
  log: string;
}
const path = "dynamic/agents/copilot-pull-request-reviewer";
const sha = /^[0-9a-f]{40}$/u;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const timestamp = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
const bot = (value: RecordValue | undefined) => value?.id === 175728472 && value.login === "Copilot" && value.type === "Bot";

function binding(proof: ForkCopilotEvidence): { number: number; head: string } | undefined {
  const { repository, repositoryId, run, job, check } = proof;
  if (!positive(repositoryId) || !positive(run.id) || !positive(run.run_attempt) || !positive(job.id)
    || !positive(run.check_suite_id) || !sha.test(run.head_sha) || run.event !== "dynamic" || run.path !== path
    || !bot(run.actor) || !bot(run.triggering_actor) || run.repository?.id !== repositoryId || run.repository.full_name !== repository
    || run.head_repository?.id !== repositoryId || run.head_repository.full_name !== repository
    || run.status !== "completed" || job.status !== "completed" || check.status !== "completed"
    || run.conclusion !== job.conclusion || job.conclusion !== check.conclusion
    || job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha
    || check.id !== job.id || check.check_suite?.id !== run.check_suite_id || check.head_sha !== run.head_sha
    || check.app?.id !== 15368 || check.name !== "copilot-pull-request-reviewer" || job.name !== check.name
    || !Array.isArray(check.pull_requests) || check.pull_requests.length !== 0
    || !Array.isArray(run.pull_requests) || run.pull_requests.length !== 0) return undefined;
  let checkUrl: URL;
  try { checkUrl = new URL(job.check_run_url); } catch { return undefined; }
  if (checkUrl.protocol !== "https:" || checkUrl.hostname !== "api.github.com" || checkUrl.port || checkUrl.search || checkUrl.hash
    || checkUrl.username || checkUrl.password || checkUrl.pathname !== `/repos/${repository}/check-runs/${check.id}`) return undefined;
  const start = timestamp(job.started_at), end = timestamp(job.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start
    || timestamp(check.started_at) !== start || timestamp(check.completed_at) !== end
    || !(timestamp(run.created_at) <= start && timestamp(run.updated_at) >= end)) return undefined;
  const steps = Array.isArray(job.steps) ? job.steps.filter((step: RecordValue) => /^Processing Request \((?:Linux|Windows)\)$/u.test(step.name) && step.conclusion !== "skipped") : [];
  if (steps.length !== 1 || steps[0].status !== "completed" || steps[0].conclusion !== "success") return undefined;
  const stepStart = timestamp(steps[0].started_at), stepEnd = timestamp(steps[0].completed_at);
  if (!(start <= stepStart && stepStart <= stepEnd && stepEnd <= end)) return undefined;
  // 只读取平台处理步骤中首次检出之前的关联记录；检出后的仓库输出不提供归属证明。
  let target: { number: number; head?: string } | undefined;
  let previous = stepStart;
  for (const raw of proof.log.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) (.*)$/u.exec(raw);
    if (!line) continue;
    const at = timestamp(line[1]);
    if (!Number.isFinite(at)) return undefined;
    const message = line[2]!;
    if (at < stepStart || at > stepEnd) continue;
    if (/^(?:Analyzing |Fetching diff |Checking out )/u.test(message)) {
      if (at < previous) return undefined;
      previous = at;
    }
    if (message.startsWith("Analyzing ")) {
      const match = /^Analyzing ([\w.-]+\/[\w.-]+) PR #(\d+), request-id [\w:-]+ \(autofind\.js version: [\w.-]+\)$/u.exec(message);
      if (target || !match || match[1] !== repository || !positive(Number(match[2]))) return undefined;
      target = { number: Number(match[2]) };
    } else if (message.startsWith("Fetching diff ")) {
      const match = /^Fetching diff ([0-9a-f]{40})\.\.\.([0-9a-f]{40}) for ([\w.-]+\/[\w.-]+)$/u.exec(message);
      if (!target || target.head || !match || match[3] !== repository || match[1] !== run.head_sha) return undefined;
      target.head = match[2]!;
    } else if (message.startsWith("Checking out ")) {
      const match = /^Checking out ([\w.-]+\/[\w.-]+) at SHA ([0-9a-f]{40}) into \S+$/u.exec(message);
      if (!target?.head || !match || match[1] !== repository || match[2] !== target.head) return undefined;
      return { number: target.number, head: target.head };
    }
  }
  return undefined;
}

export function forkCheckFor(proof: ForkCopilotEvidence, number: number, head: string): RecordValue | undefined {
  const target = binding(proof);
  return target?.number === number && target.head === head ? proof.check : undefined;
}

export async function readForkCopilotEvidence(client: GitHubClient, owner: string, repo: string, number: number, head: string, since: string, requestBoundary = Date.parse(since)): Promise<readonly ForkCopilotEvidence[]> {
  if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(requestBoundary) || Date.parse(since) > requestBoundary) throw new Error("动态审查查询边界无效");
  const repository = `${owner}/${repo}`;
  const pull = await client.getPullRequest(owner, repo, number);
  const validPull = (value: RecordValue) => value.number === number && value.head?.sha === head
    && positive(value.base?.repo?.id) && value.base.repo.full_name === repository
    && positive(value.head?.repo?.id) && value.head.repo.id !== value.base.repo.id;
  if (!validPull(pull)) return [];
  const createdAt = timestamp(pull.created_at);
  if (!Number.isFinite(createdAt) || createdAt > Date.parse(since)) throw new Error("PR创建时间无法核验");
  const createdSince = new Date(Math.floor(createdAt / 1000) * 1000).toISOString();
  const runs = await client.listDynamicWorkflowRuns(owner, repo, createdSince);
  const relevant = (values: readonly RecordValue[]) => values.filter(run => run.path === path);
  const proofs: ForkCopilotEvidence[] = [];
  for (const run of relevant(runs)) {
    if (run.status === "completed" && Number.isFinite(timestamp(run.updated_at)) && timestamp(run.updated_at) < requestBoundary) continue;
    if (run.status !== "completed") throw new Error("动态审查运行尚未完成归属核验");
    const jobs = await client.listWorkflowAttemptJobs(owner, repo, run.id, run.run_attempt);
    const matching = jobs.filter(job => job.name === "copilot-pull-request-reviewer");
    if (matching.length !== 1) throw new Error("动态审查任务归属不唯一");
    const job = matching[0]!;
    const [check, log] = await Promise.all([client.getCheckRun(owner, repo, job.id), client.getWorkflowJobLog(owner, repo, job.id)]);
    const proof: ForkCopilotEvidence = { repository, repositoryId: pull.base.repo.id, run, job, check, log };
    const target = binding(proof);
    if (!target) throw new Error("动态审查证据关联不完整");
    if (target.number === number && target.head === head) proofs.push(proof);
  }
  const [currentPull, currentRuns] = await Promise.all([client.getPullRequest(owner, repo, number), client.listDynamicWorkflowRuns(owner, repo, createdSince)]);
  const snapshot = (values: readonly RecordValue[]) => JSON.stringify(relevant(values).map(run => [run.id, run.run_attempt, run.status, run.conclusion, run.head_sha, run.updated_at]).sort((a, b) => Number(a[0]) - Number(b[0])));
  if (!validPull(currentPull) || currentPull.created_at !== pull.created_at || currentPull.base.repo.id !== pull.base.repo.id || currentPull.head.repo.id !== pull.head.repo.id
    || snapshot(runs) !== snapshot(currentRuns)) throw new Error("动态审查证据读取期间状态变化");
  return proofs;
}
