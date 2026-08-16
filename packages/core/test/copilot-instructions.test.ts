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
    expect(value).toContain("严重程度：阻断");
    expect(value).toContain("AutoCAD");
    expect(await computeCopilotInstructionsDigest(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeCopilotInstructionsDigest(value)).toBe(await computeCopilotInstructionsDigest(value));
  });

  it("拒绝超长或缺失固定字段的源文件", () => {
    const valid = "严重程度：阻断 严重程度：建议 标题： 问题： 证据： 影响： 建议： 未发现需要阻断合并的问题。 发现需要修复后再合并的问题";
    expect(() => renderCopilotInstructions(valid.repeat(400))).toThrow("4000");
    expect(() => renderCopilotInstructions(valid.replace("证据：", ""))).toThrow("证据");
  });

  it("只允许无变化、创建或唯一受管分支更新", () => {
    expect(planCopilotInstructionsSync({ current: "same", generated: "same", branchExists: true, branchOwnedBySteward: false, openPullRequests: 9 })).toBe("unchanged");
    expect(planCopilotInstructionsSync({ current: null, generated: "new", branchExists: false, branchOwnedBySteward: false, openPullRequests: 0 })).toBe("create");
    expect(planCopilotInstructionsSync({ current: "old", generated: "new", branchExists: true, branchOwnedBySteward: true, openPullRequests: 1 })).toBe("update");
    expect(() => planCopilotInstructionsSync({ current: "old", generated: "new", branchExists: true, branchOwnedBySteward: false, openPullRequests: 1 })).toThrow("冲突");
    expect(() => planCopilotInstructionsSync({ current: "old", generated: "new", branchExists: true, branchOwnedBySteward: true, openPullRequests: 2 })).toThrow("冲突");
  });
});
