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
  const diagnostic = body.trim();
  if (!/^(?:(?:Copilot (?:was |is )?)?unable to review\b[^\r\n]*|permission denied[.!]?|review (?:failed|could not be completed)[.!]?|额度(?:耗尽|不足)[。！]?|权限不足[。！]?|审查失败[。！]?)$/iu.test(diagnostic)) return undefined;
  if (/\bquota\b|额度(?:耗尽|不足)/iu.test(diagnostic)) return "failed-quota";
  if (/\b(?:permission|access|authorization)\b|权限不足/iu.test(diagnostic)) return "failed-permission";
  return "failed-other";
}
function successfulOverview(body: string): { findings: number } | undefined {
  if (body.includes("<!-- ccr-overview-v2 -->") && /^## Copilot review overview\s*$/mu.test(body)
    && /\*\*Review effort:\*\* (?:Lite|Balanced|Max)\b/u.test(body)) {
    if (/^\*\*Findings:\*\*[\t ]+None[\t ]*\r?$/mu.test(body)) return { findings: 0 };
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
  const terminals = checks.filter(check => check.status === "completed");
  if (terminals.some(check => !Number.isFinite(time(check.started_at)) || !Number.isFinite(time(check.completed_at)) || time(check.completed_at) < time(check.started_at))) return result("unknown", "terminal-check-time-unverified", evidence);
  if (active.length + terminals.length !== checks.length) return result("unknown", "unsupported-check-status", evidence);
  const attemptTime = Math.max(reviewTime, ...checks.map(check => time(check.started_at)));
  const activityTime = Math.max(attemptTime, ...terminals.map(check => time(check.completed_at)));
  const latestHistoricalReview = Math.max(-Infinity, ...input.reviews.filter(review => isCopilotIdentity(review.user?.login)).map(review => time(review.submitted_at)));
  const requestEvents = input.events.filter(event => ["review_requested", "review_request_removed"].includes(event.event) && isCopilotIdentity(event.requested_reviewer?.login)
    && (!event.commit_id || String(event.commit_id).toLowerCase() === headSha));
  const activityEvents = input.events.filter(event => event.event === "copilot_work_started" && (!event.commit_id || String(event.commit_id).toLowerCase() === headSha)
    && !active.some(check => Number.isFinite(time(event.created_at)) && time(check.started_at) <= time(event.created_at)));
  const newerEvents = [...requestEvents, ...activityEvents].filter(event =>
    !(!event.commit_id && Number.isFinite(time(event.created_at)) && Number.isFinite(latestHistoricalReview) && time(event.created_at) <= latestHistoricalReview
      && !(input.afterEventId !== undefined && Number(event.id) > input.afterEventId))
    && (!Number.isFinite(time(event.created_at)) || time(event.created_at) >= (event.event === "copilot_work_started" ? activityTime : attemptTime)));
  const removals = newerEvents.filter(event => event.event === "review_request_removed");
  let removedAt = -Infinity;
  if (removals.length) {
    const changes = newerEvents.filter(event => event.event !== "copilot_work_started");
    if (changes.some(event => !Number.isFinite(time(event.created_at)))) return result("unknown", "request-event-order-unverified", evidence);
    removedAt = Math.max(...removals.map(event => time(event.created_at)));
    const requestedAt = Math.max(-Infinity, ...changes.filter(event => event.event === "review_requested").map(event => time(event.created_at)));
    if (removedAt >= requestedAt) return result("unknown", "request-removed", evidence);
  }
  const newerRequests = newerEvents.filter(event => event.event !== "review_request_removed" && (removedAt === -Infinity || time(event.created_at) > removedAt));
  if (newerRequests.length) {
    const bound = (event: Evidence) => String(event.commit_id ?? "").toLowerCase() === headSha || (input.afterEventId !== undefined && Number(event.id) > input.afterEventId);
    if (newerRequests.every(event => bound(event) && ((Number.isFinite(time(event.created_at)) && time(event.created_at) > attemptTime && !terminals.some(check => time(check.completed_at) === time(event.created_at))) || (attemptTime === -Infinity && input.afterEventId !== undefined && Number(event.id) > input.afterEventId)))) return result("queued", "newer-request-event-confirmed");
    return result("unknown", "newer-request-attempt-unverified", evidence);
  }
  const attempts = [...checks].sort((a, b) => time(b.started_at) - time(a.started_at));
  const newestCheck = attempts[0];
  if (newestCheck) {
    const checkEvidence = { checkRunId: Number(newestCheck.id) || undefined };
    const startedAt = time(newestCheck.started_at);
    if (attempts.slice(1).some(check => check.status !== "completed" || time(check.completed_at) >= startedAt)) return result("unknown", "overlapping-check-attempts", checkEvidence);
    if (startedAt === reviewTime) return result("unknown", "review-check-attempt-order-conflict", checkEvidence);
    if (startedAt > reviewTime) {
      if (newestCheck.status !== "completed") return result(newestCheck.status === "queued" ? "queued" : "running", "bound-active-check", checkEvidence);
      return newestCheck.conclusion === "success"
        ? result("unknown", "check-without-current-review", checkEvidence)
        : result("failed-other", "bound-terminal-check-failure", checkEvidence);
    }
  }
  if (latest) {
    if (failure(String(latest.body ?? ""))) return result(failure(String(latest.body ?? ""))!, "explicit-review-failure", evidence);
    if (String(latest.state).toUpperCase() === "DISMISSED") return result("unknown", "review-dismissed", evidence);
    const overview = successfulOverview(String(latest.body ?? ""));
    if (!overview) return result("unknown", "unsupported-review-overview", evidence);
    const priorTime = ordered[1] ? time(ordered[1].submitted_at) : -Infinity;
    const requestBoundary = Math.max(priorTime, ...requestEvents.filter(event => Number.isFinite(time(event.created_at)) && time(event.created_at) <= reviewTime).map(event => time(event.created_at)));
    if (!newestCheck || newestCheck.status !== "completed" || newestCheck.conclusion !== "success" || time(newestCheck.started_at) <= requestBoundary) return result("unknown", "review-check-attempt-unverified", evidence);
    if (activityEvents.some(event => time(event.created_at) <= reviewTime && time(event.created_at) >= time(newestCheck.completed_at))) return result("unknown", "activity-check-attempt-unverified", evidence);
    return result("succeeded", "review-and-check-confirmed", { ...evidence, checkRunId: Number(newestCheck.id) || undefined, findings: overview.findings });
  }
  if ((input.requested.users ?? []).some(user => isCopilotIdentity(user.login))) return result("unknown", "pending-reviewer-head-unverified");
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
