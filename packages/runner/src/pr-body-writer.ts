import { createHash, randomUUID } from "node:crypto";
import {
  extractIssueLinksBlock,
  extractManagedPullRequestBlock,
  managedBodyOutsideIssueLinksDigest,
  removeIssueLinksBlock,
  replaceManagedPullRequestBlock,
  upsertIssueLinksBlock,
} from "../../core/src/index.js";
import type { GitHubClient } from "../../github/src/index.js";

export type DurableBodyRegionKind = "managed-pr" | "issue-links";
export interface DurableBodyRedrive {
  workflow: "pr-automation.yml" | "onboard-repository.yml" | "sync-copilot-instructions.yml" | "pr-issue-link.yml";
  inputs: Readonly<Record<string, string>>;
}

interface RuntimeIntent {
  writeId: string;
  regionKind: DurableBodyRegionKind;
  baseSha: string;
  headSha: string;
  issueGeneration: number;
  targetBlock: string | null;
  targetBodyDigest: string;
  status: "prepared" | "patched" | "compensating" | "confirmed" | "blocked";
  deliveryProven: boolean;
  blockedReason: string | null;
  redrive: DurableBodyRedrive | null;
}

function digest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function outsideDigest(body: string, regionKind: DurableBodyRegionKind): string {
  if (regionKind === "issue-links") return managedBodyOutsideIssueLinksDigest(body);
  const region = extractManagedPullRequestBlock(body);
  return digest(`${body.slice(0, region.start)}${body.slice(region.end)}`);
}

function applyRegion(body: string, regionKind: DurableBodyRegionKind, targetBlock: string | null): string {
  if (regionKind === "managed-pr") {
    if (targetBlock === null) throw new Error("拉取请求受管块不能删除");
    return replaceManagedPullRequestBlock(body, targetBlock);
  }
  return targetBlock === null ? removeIssueLinksBlock(body) : upsertIssueLinksBlock(body, targetBlock);
}

export function targetManagedBlock(body: string, regionKind: DurableBodyRegionKind): string | null {
  return regionKind === "managed-pr" ? extractManagedPullRequestBlock(body).block : extractIssueLinksBlock(body)?.block ?? null;
}

function runtimeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("RUNTIME_URL无效");
  return url.origin;
}

async function runtimeRequest<T>(input: { runtimeUrl: string; token: string; method: "GET" | "POST"; path: string; body?: unknown }): Promise<T> {
  const response = await fetch(`${runtimeBaseUrl(input.runtimeUrl)}${input.path}`, {
    method: input.method,
    headers: { Authorization: `Bearer ${input.token}`, ...(input.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  if (!response.ok) throw new Error(`正文写意图运行时请求失败:${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 512 * 1024) throw new Error("正文写意图运行时响应过大");
  try { return JSON.parse(text) as T; } catch { throw new Error("正文写意图运行时响应无效"); }
}

function pullFacts(pull: any, repositoryId: number, pullRequestNumber: number, headSha: string, baseSha: string): string {
  if (Number(pull?.number) !== pullRequestNumber || Number(pull?.base?.repo?.id) !== repositoryId || Number(pull?.head?.repo?.id) !== repositoryId
    || pull?.head?.sha !== headSha || pull?.base?.sha !== baseSha) throw new Error("拉取请求正文写入事实已经漂移");
  return String(pull?.body ?? "");
}

function matchingIntent(input: {
  intent: RuntimeIntent;
  regionKind: DurableBodyRegionKind;
  baseSha: string;
  headSha: string;
  issueGeneration: number;
  targetBlock: string | null;
  targetBodyDigest: string;
  redrive: DurableBodyRedrive;
}): boolean {
  const canonicalRedrive = (value: DurableBodyRedrive | null) => value === null ? "null" : JSON.stringify({ workflow: value.workflow, inputs: Object.fromEntries(Object.entries(value.inputs).sort(([left], [right]) => left.localeCompare(right))) });
  return input.intent.regionKind === input.regionKind
    && input.intent.baseSha === input.baseSha
    && input.intent.headSha === input.headSha
    && input.intent.issueGeneration === input.issueGeneration
    && input.intent.targetBlock === input.targetBlock
    && input.intent.targetBodyDigest === input.targetBodyDigest
    && canonicalRedrive(input.intent.redrive) === canonicalRedrive(input.redrive);
}

async function waitForIntent(input: {
  runtimeUrl: string;
  token: string;
  path: string;
  writeId: string;
  attempts: number;
}): Promise<RuntimeIntent> {
  const state = await runtimeRequest<RuntimeIntent>({
    runtimeUrl: input.runtimeUrl,
    token: input.token,
    method: "POST",
    path: `${input.path}/${input.writeId}/wait`,
    body: { attempts: input.attempts },
  });
  if (state.status === "blocked") throw new Error(`正文写意图失败:${state.blockedReason ?? "blocked"}`);
  if (state.status !== "confirmed") throw new Error("正文写意图未在固定窗口内确认");
  return state;
}

export async function updatePullRequestBodyDurably(input: {
  client: GitHubClient;
  token: string;
  runtimeUrl: string;
  owner: string;
  repo: string;
  repositoryId: number;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
  issueGeneration?: number;
  regionKind: DurableBodyRegionKind;
  targetBlock: string | null;
  redrive: DurableBodyRedrive;
  additionalPatch?: Readonly<Record<string, unknown>>;
  confirmationAttempts?: number;
}): Promise<any> {
  const attempts = input.confirmationAttempts ?? 60;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) throw new Error("正文写入确认次数无效");
  if (input.additionalPatch && Object.prototype.hasOwnProperty.call(input.additionalPatch, "body")) throw new Error("附加更新不能包含正文");
  const current = await input.client.getPullRequest(input.owner, input.repo, input.pullRequestNumber);
  const before = pullFacts(current, input.repositoryId, input.pullRequestNumber, input.headSha, input.baseSha);
  const next = applyRegion(before, input.regionKind, input.targetBlock);
  const issueGeneration = input.issueGeneration ?? 0;
  const targetBodyDigest = digest(next);
  const path = `/internal/issue-snapshots/${input.repositoryId}/body-write-intents/${input.pullRequestNumber}`;
  if (next === before) {
    const active = await runtimeRequest<RuntimeIntent | null>({ runtimeUrl: input.runtimeUrl, token: input.token, method: "GET", path: `${path}/active` });
    if (active && ["confirmed", "blocked"].includes(active.status)) {
      if (matchingIntent({ intent: active, regionKind: input.regionKind, baseSha: input.baseSha, headSha: input.headSha, issueGeneration, targetBlock: input.targetBlock, targetBodyDigest, redrive: input.redrive })) {
        await runtimeRequest<RuntimeIntent>({ runtimeUrl: input.runtimeUrl, token: input.token, method: "POST", path: `${path}/${active.writeId}/redrive-completed` });
      }
    } else if (active) {
      if (!matchingIntent({ intent: active, regionKind: input.regionKind, baseSha: input.baseSha, headSha: input.headSha, issueGeneration, targetBlock: input.targetBlock, targetBodyDigest, redrive: input.redrive })) {
        throw new Error("活动正文写意图与当前目标冲突");
      }
      if (active.status === "prepared" || active.status === "compensating") {
        await runtimeRequest<RuntimeIntent>({ runtimeUrl: input.runtimeUrl, token: input.token, method: "POST", path: `${path}/${active.writeId}/patched` });
      }
      await waitForIntent({ runtimeUrl: input.runtimeUrl, token: input.token, path, writeId: active.writeId, attempts });
    }
    return input.additionalPatch && Object.keys(input.additionalPatch).length
      ? input.client.updatePullRequest(input.owner, input.repo, input.pullRequestNumber, input.additionalPatch)
      : current;
  }
  const prepared = await runtimeRequest<RuntimeIntent>({
    runtimeUrl: input.runtimeUrl,
    token: input.token,
    method: "POST",
    path: `${path}/prepare`,
    body: {
      writeId: randomUUID(),
      regionKind: input.regionKind,
      baseSha: input.baseSha,
      headSha: input.headSha,
      issueGeneration,
      beforeBodyDigest: digest(before),
      outsideBodyDigest: outsideDigest(before, input.regionKind),
      targetBlock: input.targetBlock,
      targetBodyDigest,
      redrive: input.redrive,
    },
  });
  if (prepared.status !== "prepared" || !matchingIntent({ intent: prepared, regionKind: input.regionKind, baseSha: input.baseSha, headSha: input.headSha, issueGeneration, targetBlock: input.targetBlock, targetBodyDigest, redrive: input.redrive })) {
    throw new Error("正文写意图恢复状态与当前正文不一致");
  }
  const writeId = prepared.writeId;
  const confirmedBefore = pullFacts(await input.client.getPullRequest(input.owner, input.repo, input.pullRequestNumber), input.repositoryId, input.pullRequestNumber, input.headSha, input.baseSha);
  if (confirmedBefore !== before) {
    await runtimeRequest({ runtimeUrl: input.runtimeUrl, token: input.token, method: "POST", path: `${path}/${writeId}/block`, body: { reason: "pre-patch-drift" } });
    throw new Error("拉取请求正文写入前发生漂移");
  }
  const written = await input.client.updatePullRequest(input.owner, input.repo, input.pullRequestNumber, { ...(input.additionalPatch ?? {}), body: next });
  pullFacts(written, input.repositoryId, input.pullRequestNumber, input.headSha, input.baseSha);
  if (String(written?.body ?? "") !== next) throw new Error("拉取请求正文写入响应不一致");
  await runtimeRequest<RuntimeIntent>({ runtimeUrl: input.runtimeUrl, token: input.token, method: "POST", path: `${path}/${writeId}/patched` });
  await waitForIntent({ runtimeUrl: input.runtimeUrl, token: input.token, path, writeId, attempts });
  const finalPull = await input.client.getPullRequest(input.owner, input.repo, input.pullRequestNumber);
  const finalBody = pullFacts(finalPull, input.repositoryId, input.pullRequestNumber, input.headSha, input.baseSha);
  if (targetManagedBlock(finalBody, input.regionKind) !== input.targetBlock) throw new Error("拉取请求正文写入最终读回不一致");
  return finalPull;
}
