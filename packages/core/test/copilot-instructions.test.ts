import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { computeCopilotInstructionsDigest, planCopilotInstructionsSync, renderCopilotInstructions } from "../src/copilot-instructions.js";

describe("Copilot中文审查说明", () => {
  it("通用目标逐字等于中央源文件生成结果", async () => {
    const common = await readFile("config/copilot/common.md", "utf8");
    const target = await readFile(".github/copilot-instructions.md", "utf8");
    expect(renderCopilotInstructions(common)).toBe(target);
    expect([...target].length).toBeLessThanOrEqual(4000);
  });

  it("LayerScape按通用源、两个换行、项目补充和末尾换行组合", async () => {
    const common = await readFile("config/copilot/common.md", "utf8");
    const project = await readFile("config/copilot/layerscape.md", "utf8");
    const value = renderCopilotInstructions(common, project);
    expect(value).toBe(`${common.trimEnd()}\n\n${project.trim()}\n`);
    expect(value).toContain("当前拉取请求差异");
    expect(value).toContain("AutoCAD");
    expect(await computeCopilotInstructionsDigest(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeCopilotInstructionsDigest(value)).toBe(await computeCopilotInstructionsDigest(value));
  });

  it("只强制非空和长度，不把审查正文硬编码到生成器", () => {
    expect(renderCopilotInstructions("# 最小说明")).toBe("# 最小说明\n");
    expect(() => renderCopilotInstructions(" \n")).toThrow("不能为空");
    expect(() => renderCopilotInstructions("说明".repeat(2001))).toThrow("4000");
  });

  it("不再要求Copilot使用固定评论格式或结论文案", async () => {
    const target = await readFile(".github/copilot-instructions.md", "utf8");
    expect(target).not.toContain("严重程度：建议");
    expect(target).not.toContain("严重程度：阻断");
    expect(target).not.toContain("每条意见严格使用");
    expect(target).not.toContain("未发现需要阻断合并的问题。");
    expect(target).not.toContain("发现需要修复后再合并的问题");
  });

  it("只允许无变化、创建或唯一受管分支更新", () => {
    expect(planCopilotInstructionsSync({ current: "same", generated: "same", branchExists: true, branchOwnedBySteward: false, openPullRequests: 9 })).toBe("unchanged");
    expect(planCopilotInstructionsSync({ current: null, generated: "new", branchExists: false, branchOwnedBySteward: false, openPullRequests: 0 })).toBe("create");
    expect(planCopilotInstructionsSync({ current: "old", generated: "new", branchExists: true, branchOwnedBySteward: true, openPullRequests: 1 })).toBe("update");
    expect(() => planCopilotInstructionsSync({ current: "old", generated: "new", branchExists: true, branchOwnedBySteward: false, openPullRequests: 1 })).toThrow("冲突");
    expect(() => planCopilotInstructionsSync({ current: "old", generated: "new", branchExists: true, branchOwnedBySteward: true, openPullRequests: 2 })).toThrow("冲突");
  });
});
