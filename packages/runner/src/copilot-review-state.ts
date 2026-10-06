export type CopilotReviewStateName = "succeeded" | "queued" | "running" | "failed-quota" | "failed-permission" | "failed-other" | "none" | "unknown";
export interface CopilotReviewState {
  state: CopilotReviewStateName;
  headSha: string;
  reviewId?: number | undefined;
  checkRunId?: number | undefined;
  findings?: number;
  reason: string;
}
interface Evidence { [key: string]: any }
export interface CopilotReviewInput {
  pullRequestNumber: number;
  headSha: string;
  requested: { users?: readonly { login?: unknown }[] };
  reviews: readonly Evidence[];
  events: readonly Evidence[];
  checkRuns: readonly Evidence[];
  afterEventId?: number | undefined;
}
export function isCopilotIdentity(value: unknown): boolean {
  const login = String(value ?? "").trim().toLowerCase().replace(/\[bot\]$/u, "");
  return login === "copilot" || login === "copilot-pull-request-reviewer";
}
export function isBoundCopilotCheck(check: Evidence, number: number, head: string): boolean {
  return check.name === "copilot-pull-request-reviewer" && check.app?.id === 15368
    && String(check.head_sha ?? "").toLowerCase() === head
    && Array.isArray(check.pull_requests) && check.pull_requests.some((pull: Evidence) =>
      pull.number === number && String(pull.head?.sha ?? "").toLowerCase() === head);
}
function time(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}
function failure(body: string): CopilotReviewStateName | undefined {
  if (/unable to review[\s\S]*quota|quota (?:limit|exceeded)|额度(?:耗尽|不足)/iu.test(body)) return "failed-quota";
  if (/unable to review[\s\S]*(?:permission|access|authorization)|permission denied|权限不足/iu.test(body)) return "failed-permission";
  if (/unable to review|review (?:failed|could not be completed)|审查失败/iu.test(body)) return "failed-other";
  return undefined;
}
function successfulOverview(body: string): { findings: number } | undefined {
  if (body.includes("<!-- ccr-overview-v2 -->") && /^## Copilot review overview\s*$/mu.test(body)
    && /\*\*Review effort:\*\* (?:Lite|Balanced|Max)\b/u.test(body)) {
    const match = /\*\*Findings:\*\* (\d+)\b/u.exec(body);
    if (match && Number.isSafeInteger(Number(match[1]))) return { findings: Number(match[1]) };
  }
  const historical = /Copilot reviewed \d+ out of \d+ changed files in this pull request and generated (\d+) comments?/u.exec(body);
  if (historical && Number.isSafeInteger(Number(historical[1]))) return { findings: Number(historical[1]) };
  return undefined;
}
export function classifyCopilotReviewState(input: CopilotReviewInput): CopilotReviewState {
  const headSha = input.headSha.toLowerCase();
  const result = (state: CopilotReviewStateName, reason: string, evidence: Partial<CopilotReviewState> = {}): CopilotReviewState => ({ state, headSha, reason, ...evidence });
  if (!/^[0-9a-f]{40}$/u.test(headSha) || !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0) return result("unknown", "invalid-head-or-pr");
  const reviews = input.reviews.filter(review => isCopilotIdentity(review.user?.login) && String(review.commit_id ?? "").toLowerCase() === headSha);
  const checks = input.checkRuns.filter(check => isBoundCopilotCheck(check, input.pullRequestNumber, headSha));
  const ordered = [...reviews].sort((a, b) => time(b.submitted_at) - time(a.submitted_at));
  const latest = ordered[0];
  const reviewTime = latest ? time(latest.submitted_at) : -Infinity;
  const evidence = latest ? { reviewId: Number(latest.id) || undefined } : {};
  if (reviews.some(review => !Number.isFinite(time(review.submitted_at)))) return result("unknown", "review-time-unverified", evidence);
  if (ordered.length > 1 && time(ordered[0]!.submitted_at) === time(ordered[1]!.submitted_at)) return result("unknown", "review-attempt-order-conflict", evidence);
  const active = checks.filter(check => ["queued", "in_progress", "pending", "waiting", "requested"].includes(check.status));
  if (active.some(check => !Number.isFinite(time(check.started_at)))) return result("unknown", "check-attempt-time-unverified", evidence);
  const newestActive = [...active].sort((a, b) => time(b.started_at) - time(a.started_at))[0];
  if (newestActive && (!latest || time(newestActive.started_at) >= reviewTime)) return result(newestActive.status === "queued" ? "queued" : "running", "bound-active-check", { checkRunId: Number(newestActive.id) || undefined });
  const terminals = checks.filter(check => check.status === "completed");
  if (terminals.some(check => !Number.isFinite(time(check.started_at)) || !Number.isFinite(time(check.completed_at)) || time(check.completed_at) < time(check.started_at))) return result("unknown", "terminal-check-time-unverified", evidence);
  const newerFailure = terminals.find(check => check.conclusion !== "success" && time(check.started_at) > reviewTime);
  if (newerFailure) return result("failed-other", "bound-terminal-check-failure", { checkRunId: Number(newerFailure.id) || undefined });
  const newerRequests = input.events.filter(event => ((event.event === "review_requested" && isCopilotIdentity(event.requested_reviewer?.login)) || event.event === "copilot_work_started")
    && (!Number.isFinite(time(event.created_at)) || time(event.created_at) > reviewTime));
  if (latest && newerRequests.length) {
    if (newerRequests.every(event => Number.isFinite(time(event.created_at)) && (String(event.commit_id ?? "").toLowerCase() === headSha || (input.afterEventId !== undefined && Number(event.id) > input.afterEventId)))) return result("queued", "newer-request-event-confirmed");
    return result("unknown", "newer-request-attempt-unverified", evidence);
  }
  if (latest) {
    if (failure(String(latest.body ?? ""))) return result(failure(String(latest.body ?? ""))!, "explicit-review-failure", evidence);
    if (String(latest.state).toUpperCase() === "DISMISSED") return result("unknown", "review-dismissed", evidence);
    const overview = successfulOverview(String(latest.body ?? ""));
    if (!overview) return result("unknown", "unsupported-review-overview", evidence);
    const priorTime = ordered[1] ? time(ordered[1].submitted_at) : -Infinity;
    const matches = terminals.filter(check => check.conclusion === "success" && time(check.started_at) <= reviewTime && time(check.started_at) > priorTime);
    if (matches.length !== 1 || active.length || terminals.some(check => time(check.started_at) > reviewTime || (check.conclusion !== "success" && time(check.started_at) > priorTime))) return result("unknown", "review-check-attempt-unverified", evidence);
    return result("succeeded", "review-and-check-confirmed", { ...evidence, checkRunId: Number(matches[0]!.id) || undefined, findings: overview.findings });
  }
  const newRequest = input.events.some(event => (event.commit_id === headSha || (input.afterEventId !== undefined && Number(event.id) > input.afterEventId))
    && ((event.event === "review_requested" && isCopilotIdentity(event.requested_reviewer?.login)) || event.event === "copilot_work_started"));
  if (newRequest) return result("queued", "request-event-confirmed");
  if ((input.requested.users ?? []).some(user => isCopilotIdentity(user.login))) return result("unknown", "pending-reviewer-head-unverified");
  const latestHistoricalReview = Math.max(-Infinity, ...input.reviews.filter(review => isCopilotIdentity(review.user?.login)).map(review => time(review.submitted_at)));
  if (input.events.some(event => !event.commit_id && ((event.event === "review_requested" && isCopilotIdentity(event.requested_reviewer?.login)) || event.event === "copilot_work_started")
    && (!Number.isFinite(time(event.created_at)) || time(event.created_at) > latestHistoricalReview))) return result("unknown", "request-event-head-unverified");
  if (checks.length) return result("unknown", "check-without-review");
  return result("none", "no-current-head-evidence");
}

export type CopilotReviewTrigger = "legacy" | "native";
export function copilotReviewTrigger(value: unknown): CopilotReviewTrigger {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "native") return "native";
  throw new Error("Copilot审查触发模式无效");
}
