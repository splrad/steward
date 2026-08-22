import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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

interface RuntimeIntent {
  writeId: string;
  status: "prepared" | "patched" | "compensating" | "confirmed" | "blocked";
  deliveryProven: boolean;
  blockedReason: string | null;
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
  additionalPatch?: Readonly<Record<string, unknown>>;
  confirmationAttempts?: number;
}): Promise<any> {
  const current = await input.client.getPullRequest(input.owner, input.repo, input.pullRequestNumber);
  const before = pullFacts(current, input.repositoryId, input.pullRequestNumber, input.headSha, input.baseSha);
  const next = applyRegion(before, input.regionKind, input.targetBlock);
  if (next === before) {
    return input.additionalPatch && Object.keys(input.additionalPatch).length
      ? input.client.updatePullRequest(input.owner, input.repo, input.pullRequestNumber, input.additionalPatch)
      : current;
  }
  const writeId = randomUUID();
  const path = `/internal/issue-snapshots/${input.repositoryId}/body-write-intents/${input.pullRequestNumber}`;
  await runtimeRequest<RuntimeIntent>({
    runtimeUrl: input.runtimeUrl,
    token: input.token,
    method: "POST",
    path: `${path}/prepare`,
    body: {
      writeId,
      regionKind: input.regionKind,
      baseSha: input.baseSha,
      headSha: input.headSha,
      issueGeneration: input.issueGeneration ?? 0,
      beforeBodyDigest: digest(before),
      outsideBodyDigest: outsideDigest(before, input.regionKind),
      targetBlock: input.targetBlock,
      targetBodyDigest: digest(next),
    },
  });
  const confirmedBefore = pullFacts(await input.client.getPullRequest(input.owner, input.repo, input.pullRequestNumber), input.repositoryId, input.pullRequestNumber, input.headSha, input.baseSha);
  if (confirmedBefore !== before) {
    await runtimeRequest({ runtimeUrl: input.runtimeUrl, token: input.token, method: "POST", path: `${path}/${writeId}/block`, body: { reason: "pre-patch-drift" } });
    throw new Error("拉取请求正文写入前发生漂移");
  }
  const written = await input.client.updatePullRequest(input.owner, input.repo, input.pullRequestNumber, { ...(input.additionalPatch ?? {}), body: next });
  pullFacts(written, input.repositoryId, input.pullRequestNumber, input.headSha, input.baseSha);
  if (String(written?.body ?? "") !== next) throw new Error("拉取请求正文写入响应不一致");
  await runtimeRequest<RuntimeIntent>({ runtimeUrl: input.runtimeUrl, token: input.token, method: "POST", path: `${path}/${writeId}/patched` });
  const attempts = input.confirmationAttempts ?? 60;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) throw new Error("正文写入确认次数无效");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await runtimeRequest<RuntimeIntent>({ runtimeUrl: input.runtimeUrl, token: input.token, method: "GET", path: `${path}/${writeId}` });
    if (state.status === "blocked") throw new Error(`正文写意图失败:${state.blockedReason ?? "blocked"}`);
    if (state.status === "confirmed") {
      const finalPull = await input.client.getPullRequest(input.owner, input.repo, input.pullRequestNumber);
      const finalBody = pullFacts(finalPull, input.repositoryId, input.pullRequestNumber, input.headSha, input.baseSha);
      if (targetManagedBlock(finalBody, input.regionKind) !== input.targetBlock) throw new Error("拉取请求正文写入最终读回不一致");
      return finalPull;
    }
    if (state.status === "patched" && state.deliveryProven) {
      const confirmed = await runtimeRequest<RuntimeIntent>({ runtimeUrl: input.runtimeUrl, token: input.token, method: "POST", path: `${path}/${writeId}/confirm` });
      if (confirmed.status === "confirmed") {
        const finalPull = await input.client.getPullRequest(input.owner, input.repo, input.pullRequestNumber);
        const finalBody = pullFacts(finalPull, input.repositoryId, input.pullRequestNumber, input.headSha, input.baseSha);
        if (targetManagedBlock(finalBody, input.regionKind) !== input.targetBlock) throw new Error("拉取请求正文写入最终读回不一致");
        return finalPull;
      }
    }
    if (attempt + 1 < attempts) await delay(500);
  }
  throw new Error("正文写意图未在固定窗口内确认");
}
