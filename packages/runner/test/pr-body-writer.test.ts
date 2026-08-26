import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractManagedPullRequestBlock, renderManagedBody } from "../../core/src/automation.js";
import { targetManagedBlock, updatePullRequestBodyDurably } from "../src/pr-body-writer.js";

const repositoryId = 1296724484;
const pullRequestNumber = 42;
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const redrive = { workflow: "sync-copilot-instructions.yml" as const, inputs: { repositoryId: String(repositoryId) } };

afterEach(() => vi.unstubAllGlobals());

function block(summary: string): string {
  return extractManagedPullRequestBlock(renderManagedBody({
    generated: { type: "chore", scope: "test", title: "测试", summary, motivation: "原因", changes: ["改动"], impact: [], releaseAndMigration: [] },
    templateBody: "<!-- workflow:managed-pr:start -->\n<!-- workflow:managed-pr:end -->\n",
    actor: "splrad-steward[bot]",
    contributors: [],
    context: "test",
  })).block;
}

function pull(body: string): any {
  return { number: pullRequestNumber, body, head: { sha: headSha, repo: { id: repositoryId } }, base: { sha: baseSha, repo: { id: repositoryId } } };
}

function intentFromRequest(init: RequestInit, status: "prepared" | "patched" | "confirmed" = "prepared", writeId = "id"): any {
  const request = JSON.parse(String(init.body ?? "{}"));
  return { ...request, writeId, status, deliveryProven: status === "confirmed", blockedReason: null };
}

describe("Runner正文持久写入器", () => {
  it("持久化成功、交付已证明且Runtime确认后才返回", async () => {
    let live = `人工前言\n${block("旧摘要")}\n`;
    const targetBlock = block("新摘要");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const value = String(url); calls.push(`${init.method ?? "GET"} ${value}`);
      if (value.endsWith("/prepare")) return new Response(JSON.stringify(intentFromRequest(init)), { status: 200 });
      if (value.endsWith("/patched")) return new Response(JSON.stringify({ writeId: "id", status: "patched" }), { status: 200 });
      if (value.endsWith("/wait")) return new Response(JSON.stringify({ writeId: "id", status: "confirmed", deliveryProven: true, blockedReason: null }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const client = {
      getPullRequest: async () => pull(live),
      updatePullRequest: async (_owner: string, _repo: string, _number: number, patch: any) => pull(live = patch.body),
    } as any;
    const result = await updatePullRequestBodyDurably({ client, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, regionKind: "managed-pr", targetBlock, redrive });
    expect(result.body).toContain("新摘要");
    expect(calls.some((value) => value.endsWith("/prepare"))).toBe(true);
    expect(calls.some((value) => value.endsWith("/patched"))).toBe(true);
    expect(calls.filter((value) => value.endsWith("/wait"))).toHaveLength(1);
    expect(calls.some((value) => value.endsWith("/confirm"))).toBe(false);
  });

  it("写意图绑定实时分析base并独立核对PR对象base", async () => {
    const pullBaseSha = "c".repeat(40);
    let live = `人工前言\n${block("旧摘要")}\n`;
    const targetBlock = block("新摘要");
    let preparedBody: any = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const value = String(url);
      if (value.endsWith("/prepare")) {
        preparedBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify(intentFromRequest(init)), { status: 200 });
      }
      if (value.endsWith("/patched")) return new Response(JSON.stringify({ writeId: "id", status: "patched" }), { status: 200 });
      if (value.endsWith("/wait")) return new Response(JSON.stringify({ writeId: "id", status: "confirmed", deliveryProven: true, blockedReason: null }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const currentPull = (body: string) => ({ ...pull(body), base: { sha: pullBaseSha, repo: { id: repositoryId } } });
    const client = {
      getPullRequest: async () => currentPull(live),
      updatePullRequest: async (_owner: string, _repo: string, _number: number, patch: any) => currentPull(live = patch.body),
    } as any;
    await updatePullRequestBodyDurably({ client, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, pullBaseSha, regionKind: "managed-pr", targetBlock, redrive });
    expect(preparedBody).toEqual(expect.objectContaining({ baseSha, pullBaseSha, headSha }));
  });

  it("写意图持久化失败时不调用GitHub PATCH", async () => {
    const before = `人工前言\n${block("旧摘要")}\n`;
    const updatePullRequest = vi.fn();
    vi.stubGlobal("fetch", async () => new Response("failed", { status: 503 }));
    await expect(updatePullRequestBodyDurably({ client: { getPullRequest: async () => pull(before), updatePullRequest } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, regionKind: "managed-pr", targetBlock: block("新摘要"), redrive })).rejects.toThrow("运行时请求失败");
    expect(updatePullRequest).not.toHaveBeenCalled();
  });

  it("持久化后正文漂移会阻断且不覆盖人工修改", async () => {
    const before = `人工前言\n${block("旧摘要")}\n`;
    const drifted = `人工前言\n人工追加\n${block("旧摘要")}\n`;
    let reads = 0;
    const updatePullRequest = vi.fn();
    const runtimeCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      runtimeCalls.push(String(url));
      return new Response(JSON.stringify(intentFromRequest(init)), { status: 200 });
    });
    await expect(updatePullRequestBodyDurably({ client: { getPullRequest: async () => pull(reads++ === 0 ? before : drifted), updatePullRequest } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, regionKind: "managed-pr", targetBlock: block("新摘要"), redrive })).rejects.toThrow("写入前发生漂移");
    expect(updatePullRequest).not.toHaveBeenCalled();
    expect(runtimeCalls.some((value) => value.endsWith("/block"))).toBe(true);
  });

  it("GitHub PATCH后状态推进失败不会伪报完成", async () => {
    let live = `人工前言\n${block("旧摘要")}\n`;
    let requests = 0;
    const updatePullRequest = vi.fn(async (_owner: string, _repo: string, _number: number, patch: any) => pull(live = patch.body));
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => ++requests === 1
      ? new Response(JSON.stringify(intentFromRequest(init)), { status: 200 })
      : new Response("failed", { status: 503 }));
    await expect(updatePullRequestBodyDurably({ client: { getPullRequest: async () => pull(live), updatePullRequest } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, regionKind: "managed-pr", targetBlock: block("新摘要"), redrive })).rejects.toThrow("运行时请求失败");
    expect(updatePullRequest).toHaveBeenCalledOnce();
  });

  it("损坏或混用的目标受管块在任何外部写入前被拒绝", () => {
    expect(() => targetManagedBlock("<!-- workflow:managed-pr:start -->\n损坏", "managed-pr")).toThrow("标记");
  });

  it("附加正文和无效确认次数在任何读取或写入前被拒绝", async () => {
    const getPullRequest = vi.fn();
    const updatePullRequest = vi.fn();
    const common = { client: { getPullRequest, updatePullRequest } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, regionKind: "managed-pr" as const, targetBlock: block("新摘要"), redrive };
    await expect(updatePullRequestBodyDurably({ ...common, additionalPatch: { body: "绕过" } })).rejects.toThrow("不能包含正文");
    await expect(updatePullRequestBodyDurably({ ...common, confirmationAttempts: 0 })).rejects.toThrow("确认次数无效");
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(updatePullRequest).not.toHaveBeenCalled();
  });

  it("正文PATCH成功但状态回写失败后复用活动意图恢复且不重复PATCH", async () => {
    const live = `人工前言\n${block("新摘要")}\n`;
    const targetBlock = block("新摘要");
    const targetBodyDigest = createHash("sha256").update(live, "utf8").digest("hex");
    const updatePullRequest = vi.fn();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url); calls.push(value);
      if (value.endsWith("/active")) return new Response(JSON.stringify({ writeId: "saved-id", regionKind: "managed-pr", baseSha, pullBaseSha: baseSha, headSha, issueGeneration: 0, targetBlock, targetBodyDigest, status: "prepared", deliveryProven: false, blockedReason: null, redrive }), { status: 200 });
      if (value.endsWith("/patched")) return new Response(JSON.stringify({ writeId: "saved-id", status: "patched" }), { status: 200 });
      if (value.endsWith("/wait")) return new Response(JSON.stringify({ writeId: "saved-id", status: "confirmed", deliveryProven: true, blockedReason: null }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const result = await updatePullRequestBodyDurably({ client: { getPullRequest: async () => pull(live), updatePullRequest } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, regionKind: "managed-pr", targetBlock, redrive, confirmationAttempts: 1 });
    expect(result.body).toBe(live);
    expect(updatePullRequest).not.toHaveBeenCalled();
    expect(calls.some((value) => value.endsWith("/saved-id/patched"))).toBe(true);
    expect(calls.filter((value) => value.endsWith("/saved-id/wait"))).toHaveLength(1);
  });

  it("正文已收敛时先绑定同目标迁移前活动意图再恢复", async () => {
    const pullBaseSha = "c".repeat(40);
    const live = `人工前言\n${block("新摘要")}\n`;
    const targetBlock = block("新摘要");
    const targetBodyDigest = createHash("sha256").update(live, "utf8").digest("hex");
    const updatePullRequest = vi.fn();
    const calls: string[] = [];
    let bindingBody: unknown;
    const legacy = { writeId: "saved-id", regionKind: "managed-pr", baseSha, pullBaseSha: null, headSha, issueGeneration: 0, targetBlock, targetBodyDigest, status: "prepared", deliveryProven: false, blockedReason: null, redrive };
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const value = String(url); calls.push(`${init.method ?? "GET"} ${value}`);
      if (value.endsWith("/active")) return new Response(JSON.stringify(legacy), { status: 200 });
      if (value.endsWith("/pull-base")) {
        bindingBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ...legacy, pullBaseSha }), { status: 200 });
      }
      if (value.endsWith("/patched")) return new Response(JSON.stringify({ ...legacy, pullBaseSha, status: "patched" }), { status: 200 });
      if (value.endsWith("/wait")) return new Response(JSON.stringify({ ...legacy, pullBaseSha, status: "confirmed", deliveryProven: true }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const currentPull = { ...pull(live), base: { sha: pullBaseSha, repo: { id: repositoryId } } };
    await expect(updatePullRequestBodyDurably({ client: { getPullRequest: async () => currentPull, updatePullRequest } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, pullBaseSha, regionKind: "managed-pr", targetBlock, redrive, confirmationAttempts: 1 })).resolves.toEqual(currentPull);
    expect(bindingBody).toEqual({ pullBaseSha });
    expect(calls.filter((value) => value.endsWith("/saved-id/pull-base"))).toHaveLength(1);
    expect(calls.some((value) => value.endsWith("/saved-id/patched"))).toBe(true);
    expect(updatePullRequest).not.toHaveBeenCalled();
  });

  it("显式等于分析base的活动意图不会被误判为迁移前记录", async () => {
    const pullBaseSha = "c".repeat(40);
    const live = `人工前言\n${block("新摘要")}\n`;
    const targetBlock = block("新摘要");
    const targetBodyDigest = createHash("sha256").update(live, "utf8").digest("hex");
    const updatePullRequest = vi.fn();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url); calls.push(value);
      if (value.endsWith("/active")) return new Response(JSON.stringify({ writeId: "saved-id", regionKind: "managed-pr", baseSha, pullBaseSha: baseSha, headSha, issueGeneration: 0, targetBlock, targetBodyDigest, status: "prepared", deliveryProven: false, blockedReason: null, redrive }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const currentPull = { ...pull(live), base: { sha: pullBaseSha, repo: { id: repositoryId } } };
    await expect(updatePullRequestBodyDurably({ client: { getPullRequest: async () => currentPull, updatePullRequest } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, pullBaseSha, regionKind: "managed-pr", targetBlock, redrive })).rejects.toThrow("活动正文写意图与当前目标冲突");
    expect(calls.some((value) => value.endsWith("/pull-base"))).toBe(false);
    expect(updatePullRequest).not.toHaveBeenCalled();
  });

  it("目标正文已经收敛时未声明的原工作流不确认重调度并继续后续步骤", async () => {
    const live = `人工前言\n${block("新摘要")}\n`;
    const targetBlock = block("新摘要");
    const targetBodyDigest = createHash("sha256").update(live, "utf8").digest("hex");
    const updatePullRequest = vi.fn(async (_owner: string, _repo: string, _number: number, patch: any) => ({ ...pull(live), ...patch }));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url); calls.push(value);
      if (value.endsWith("/active")) return new Response(JSON.stringify({ writeId: "blocked-id", regionKind: "managed-pr", baseSha, pullBaseSha: baseSha, headSha, issueGeneration: 0, targetBlock, targetBodyDigest, status: "blocked", deliveryProven: false, blockedReason: "edited-evidence-unavailable", redrive, redriveRequired: true, redriveDispatched: false }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    await expect(updatePullRequestBodyDurably({ client: { getPullRequest: async () => pull(live), updatePullRequest } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, regionKind: "managed-pr", targetBlock, redrive, additionalPatch: { title: "新标题" } })).resolves.toEqual(expect.objectContaining({ title: "新标题" }));
    expect(updatePullRequest).toHaveBeenCalledOnce();
    expect(calls.some((value) => value.endsWith("/blocked-id/redrive-completed"))).toBe(false);
  });

  it("目标正文已经收敛时确认已声明且输入经过规范替换的恢复重调度", async () => {
    const live = `人工前言\n${block("新摘要")}\n`;
    const targetBlock = block("新摘要");
    const targetBodyDigest = createHash("sha256").update(live, "utf8").digest("hex");
    const writeId = "77777777-7777-4777-8777-777777777777";
    const originRedrive = { workflow: "pr-automation.yml" as const, inputs: { deliveryId: "delivery-original", repositoryId: String(repositoryId), sourceRef: "refs/heads/feature/test", eventAfterSha: headSha, sourceActorId: "44151430", sourceActorLogin: "axiomoth", policySha: "c".repeat(40) } };
    const recoveryRedrive = { workflow: "pr-automation.yml" as const, inputs: { ...originRedrive.inputs, deliveryId: `body-write-recovery:${writeId}`, policySha: "d".repeat(40) } };
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url); calls.push(value);
      if (value.endsWith("/active")) return new Response(JSON.stringify({ writeId, regionKind: "managed-pr", baseSha, pullBaseSha: baseSha, headSha, issueGeneration: 0, targetBlock, targetBodyDigest, status: "confirmed", deliveryProven: true, blockedReason: null, redrive: originRedrive, redriveRequired: true, redriveDispatched: true }), { status: 200 });
      if (value.endsWith(`/${writeId}/redrive-completed`)) return new Response(JSON.stringify({ writeId, status: "confirmed", redriveRequired: false, redriveDispatched: true }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    await expect(updatePullRequestBodyDurably({ client: { getPullRequest: async () => pull(live), updatePullRequest: vi.fn() } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, regionKind: "managed-pr", targetBlock, redrive: recoveryRedrive })).resolves.toEqual(pull(live));
    expect(calls.filter((value) => value.endsWith(`/${writeId}/redrive-completed`))).toHaveLength(1);
  });

  it("终态迁移前意图在双base不同时仍能确认恢复重调度", async () => {
    const pullBaseSha = "e".repeat(40);
    const live = `人工前言\n${block("新摘要")}\n`;
    const targetBlock = block("新摘要");
    const targetBodyDigest = createHash("sha256").update(live, "utf8").digest("hex");
    const writeId = "88888888-8888-4888-8888-888888888888";
    const originRedrive = { workflow: "pr-automation.yml" as const, inputs: { deliveryId: "delivery-legacy-terminal", repositoryId: String(repositoryId), sourceRef: "refs/heads/feature/test", eventAfterSha: headSha, sourceActorId: "44151430", sourceActorLogin: "axiomoth", policySha: "c".repeat(40) } };
    const recoveryRedrive = { workflow: "pr-automation.yml" as const, inputs: { ...originRedrive.inputs, deliveryId: `body-write-recovery:${writeId}`, policySha: "d".repeat(40) } };
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url); calls.push(value);
      if (value.endsWith("/active")) return new Response(JSON.stringify({ writeId, regionKind: "managed-pr", baseSha, pullBaseSha: null, headSha, issueGeneration: 0, targetBlock, targetBodyDigest, status: "confirmed", deliveryProven: true, blockedReason: null, redrive: originRedrive, redriveRequired: true, redriveDispatched: true }), { status: 200 });
      if (value.endsWith(`/${writeId}/redrive-completed`)) return new Response(JSON.stringify({ writeId, status: "confirmed", redriveRequired: false, redriveDispatched: true }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const currentPull = { ...pull(live), base: { sha: pullBaseSha, repo: { id: repositoryId } } };
    await expect(updatePullRequestBodyDurably({ client: { getPullRequest: async () => currentPull, updatePullRequest: vi.fn() } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, pullBaseSha, regionKind: "managed-pr", targetBlock, redrive: recoveryRedrive })).resolves.toEqual(currentPull);
    expect(calls.filter((value) => value.endsWith(`/${writeId}/redrive-completed`))).toHaveLength(1);
  });

  it("终态显式异base意图不会确认恢复重调度", async () => {
    const pullBaseSha = "e".repeat(40);
    const live = `人工前言\n${block("新摘要")}\n`;
    const targetBlock = block("新摘要");
    const targetBodyDigest = createHash("sha256").update(live, "utf8").digest("hex");
    const writeId = "99999999-9999-4999-8999-999999999999";
    const originRedrive = { workflow: "pr-automation.yml" as const, inputs: { deliveryId: "delivery-explicit-terminal", repositoryId: String(repositoryId), sourceRef: "refs/heads/feature/test", eventAfterSha: headSha, sourceActorId: "44151430", sourceActorLogin: "axiomoth", policySha: "c".repeat(40) } };
    const recoveryRedrive = { workflow: "pr-automation.yml" as const, inputs: { ...originRedrive.inputs, deliveryId: `body-write-recovery:${writeId}`, policySha: "d".repeat(40) } };
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const value = String(url); calls.push(value);
      if (value.endsWith("/active")) return new Response(JSON.stringify({ writeId, regionKind: "managed-pr", baseSha, pullBaseSha: baseSha, headSha, issueGeneration: 0, targetBlock, targetBodyDigest, status: "confirmed", deliveryProven: true, blockedReason: null, redrive: originRedrive, redriveRequired: true, redriveDispatched: true }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    const currentPull = { ...pull(live), base: { sha: pullBaseSha, repo: { id: repositoryId } } };
    await expect(updatePullRequestBodyDurably({ client: { getPullRequest: async () => currentPull, updatePullRequest: vi.fn() } as any, token: "token", runtimeUrl: "https://runtime.test", owner: "splrad", repo: "steward", repositoryId, pullRequestNumber, headSha, baseSha, pullBaseSha, regionKind: "managed-pr", targetBlock, redrive: recoveryRedrive })).resolves.toEqual(currentPull);
    expect(calls.some((value) => value.endsWith(`/${writeId}/redrive-completed`))).toBe(false);
  });
});
