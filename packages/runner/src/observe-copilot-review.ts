import {writeFile} from 'node:fs/promises';
import {GitHubClient} from '../../github/src/client.js';
import {readForkCopilotEvidence} from './copilot-fork-evidence.js';
import {classifyCopilotReviewState,isCopilotIdentity,type CopilotReviewState} from './copilot-review-state.js';
function splitRepository(fullName:string):[string,string] { if(!/^[\w.-]+\/[\w.-]+$/.test(fullName))throw Error('REVIEW_REPOSITORY');return fullName.split('/') as [string,string]; }
function required(args: Readonly<Record<string, string>>, name: string): string {
  const value = args[name]; if (!value) throw new Error(`缺少参数: --${name}`); return value;
}
export function env(name: string): string { const value = process.env[name]; if (!value) throw new Error(`缺少环境变量: ${name}`); return value; }
function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name}必须是十进制整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name}必须是安全整数`);
  return parsed;
}
function sha(value: string, name: string): string { if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${name}必须是40位提交编号`); return value.toLowerCase(); }
async function summary(lines: readonly string[]): Promise<void> {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) await writeFile(target, `${lines.join("\n")}\n`, { flag: "a" }); else process.stdout.write(`${lines.join("\n")}\n`);
}
async function output(values: Record<string, string | number>): Promise<void> { const target = process.env.GITHUB_OUTPUT; if (!target) return; await writeFile(target, Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}`).join("\n") + "\n", { flag: "a" }); }

export async function readCopilotReviewState(clientValue: GitHubClient, owner: string, repo: string, number: number, headSha: string, afterEventId?: number): Promise<CopilotReviewState> {
  try {
    const [requested, reviews, events, checkRuns] = await Promise.all([
      clientValue.getRequestedReviewers(owner, repo, number),
      clientValue.listPullRequestReviews(owner, repo, number),
      clientValue.listIssueEvents(owner, repo, number),
      clientValue.listAllCheckRuns(owner, repo, headSha, "all"),
    ]);
    const input = { pullRequestNumber: number, headSha, requested, reviews, events, checkRuns, afterEventId };
    const initial = classifyCopilotReviewState(input);
    if (initial.reason !== "review-check-attempt-unverified") return initial;
    const reviewTime = Math.max(...reviews.filter(review => isCopilotIdentity(review.user?.login) && review.commit_id === headSha).map(review => Date.parse(review.submitted_at)));
    const requests = events.filter(event => event.event === "review_requested" && isCopilotIdentity(event.requested_reviewer?.login)
      && (!event.commit_id || event.commit_id === headSha) && Date.parse(event.created_at) <= reviewTime);
    const since = Math.min(...requests.map(event => Date.parse(event.created_at)));
    const requestBoundary = Math.max(...requests.map(event => Date.parse(event.created_at)));
    if (!Number.isFinite(since)) return initial;
    const forkEvidence = await readForkCopilotEvidence(clientValue, owner, repo, number, headSha, new Date(since).toISOString(), requestBoundary);
    if (!forkEvidence.length) return initial;
    const [freshRequested, freshReviews, freshEvents, freshChecks] = await Promise.all([
      clientValue.getRequestedReviewers(owner, repo, number), clientValue.listPullRequestReviews(owner, repo, number),
      clientValue.listIssueEvents(owner, repo, number), clientValue.listAllCheckRuns(owner, repo, headSha, "all"),
    ]);
    if (JSON.stringify([requested, reviews, events, checkRuns]) !== JSON.stringify([freshRequested, freshReviews, freshEvents, freshChecks])) {
      return { state: "unknown", headSha, reason: "review-evidence-changed" };
    }
    return classifyCopilotReviewState({ ...input, forkEvidence });
  } catch {
    return { state: "unknown", headSha, reason: "evidence-read-failed" };
  }
}
export async function observeCopilotReviewCommand(args: Readonly<Record<string, string>>) {
  const repositoryId = integer(required(args, "repository-id"), "repository-id");
  const number = integer(required(args, "pull-request-number"), "pull-request-number");
  const headSha = sha(required(args, "event-head-sha"), "event-head-sha");
  const gh = new GitHubClient(env("GITHUB_TOKEN"));
  const repository = await gh.getRepositoryById(repositoryId);
  const eligibleRepository = (value: any) => {
    return value.id === repositoryId && value.owner?.id === 302208797 && value.owner?.login === "splrad"
      && !value.archived && !value.disabled;
  };
  if (!eligibleRepository(repository)) throw new Error("仓库不在审查观察范围内");
  const [owner, repo] = splitRepository(repository.full_name);
  const eligiblePull = (pull: any) => pull.number === number && pull.state === "open"
    && pull.base?.repo?.id === repositoryId && pull.base?.ref === repository.default_branch && pull.head?.sha === headSha;
  if (!eligiblePull(await gh.getPullRequest(owner, repo, number))) throw new Error("PR不在审查观察范围内或head已变化");
  const state = await readCopilotReviewState(gh, owner, repo, number, headSha);
  const [freshRepository, freshPull] = await Promise.all([gh.getRepositoryById(repositoryId), gh.getPullRequest(owner, repo, number)]);
  if (!eligibleRepository(freshRepository) || freshRepository.full_name !== repository.full_name
    || freshRepository.default_branch !== repository.default_branch || !eligiblePull(freshPull)) throw new Error("审查观察期间PR或仓库状态变化");
  await summary([JSON.stringify({ repository: repository.full_name, number, ...state })]);
  await output({ state: state.state, reason: state.reason, headSha });
}
