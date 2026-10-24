import { describe, expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { generateOrganizationReviewInstructions, generateReviewInstructionSet } from "../../core/src/index.js";
import { GitHubRequestError } from "../../github/src/index.js";
import { main } from "../src/index.js";

const base = "a".repeat(40);
const retiredPath = ".github/copilot-instructions.md";

describe("审查文件受控退役", () => {
  it("全部profile采用旧摘要后仍可导出新组织文本，仓库生成继续拒绝旧摘要", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-export-"));
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("导出不应访问网络"); }));
    try {
      await cp(resolve("config"), join(directory, "config"), { recursive: true });
      const profiles = JSON.parse(await readFile(join(directory, "config/review/profiles.json"), "utf8"));
      const rules = JSON.parse(await readFile(join(directory, "config/review/rules.json"), "utf8"));
      delete profiles.$schema; delete rules.$schema;
      const original = await generateOrganizationReviewInstructions(profiles, rules);
      for (const profile of profiles.profiles) profile.organizationInstructionsDigest = original.digest;
      rules.rules.find((rule: any) => rule.id === "common.direct-evidence").consequence += "更新后的规则";
      await writeFile(join(directory, "config/review/profiles.json"), JSON.stringify(profiles));
      await writeFile(join(directory, "config/review/rules.json"), JSON.stringify(rules));
      vi.stubEnv("STEWARD_CONFIG_DIRECTORY", join(directory, "config"));
      await main(["render-review-instructions", "--policy-sha", base]);
      const exported = JSON.parse(String(output.mock.calls[0]![0]));
      expect(exported.organization).toEqual(await generateOrganizationReviewInstructions(profiles, rules));
      expect(exported.organization.digest).not.toBe(original.digest);
      expect(exported).not.toHaveProperty("repository");
      for (const profile of profiles.profiles) {
        await expect(main(["render-review-instructions", "--profile", profile.id, "--policy-sha", base])).rejects.toThrow("摘要与当前中央规则不一致");
      }
    } finally { output.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["absent", "directory", "file", "parent-file"])("本地校验直接核对退役路径：%s", async kind => {
    const directory = await mkdtemp(join(tmpdir(), "review-validation-"));
    try {
      await cp(resolve("config"), join(directory, "config"), { recursive: true });
      const profiles = JSON.parse(await readFile(join(directory, "config/review/profiles.json"), "utf8"));
      const rules = JSON.parse(await readFile(join(directory, "config/review/rules.json"), "utf8"));
      delete profiles.$schema; delete rules.$schema;
      profiles.profiles.find((profile: any) => profile.id === "steward").organizationInstructionsDigest = (await generateOrganizationReviewInstructions(profiles, rules)).digest;
      await writeFile(join(directory, "config/review/profiles.json"), JSON.stringify(profiles));
      const registry = JSON.parse(await readFile(join(directory, "config/repositories.json"), "utf8"));
      registry.repositories["1296724484"].allowedWorkflowPaths = [];
      await writeFile(join(directory, "config/repositories.json"), JSON.stringify(registry));
      const validation = JSON.parse(await readFile(join(directory, "config/profiles/validation/steward.json"), "utf8"));
      // This fixture isolates instruction retirement from remote contract authorization.
      validation.tasks = ["verify-review-instructions"];
      await writeFile(join(directory, "config/profiles/validation/steward.json"), JSON.stringify(validation));
      const workspace = join(directory, "workspace");
      await mkdir(workspace);
      await mkdir(join(workspace, "config"));
      await writeFile(join(workspace, "config/repositories.json"), JSON.stringify(registry));
      const instructions = await generateReviewInstructionSet("steward", profiles, rules);
      await writeFile(join(workspace, "AGENTS.md"), instructions.files[0].content);
      if (kind === "directory") {
        await mkdir(join(workspace, retiredPath), { recursive: true });
        await writeFile(join(workspace, retiredPath, "manual.md"), "人工内容");
      } else if (kind === "file") {
        await mkdir(join(workspace, ".github"));
        await writeFile(join(workspace, retiredPath), "人工内容");
      } else if (kind === "parent-file") await writeFile(join(workspace, ".github"), "阻挡路径的文件");
      vi.stubEnv("STEWARD_CONFIG_DIRECTORY", join(directory, "config"));
      vi.stubEnv("GITHUB_STEP_SUMMARY", join(directory, "summary"));
      vi.stubEnv("VALIDATION_BASE_SHA", ""); vi.stubEnv("VALIDATION_BASE_REF", "");
      const validationRun = main(["validate", "--workspace", workspace, "--repository-id", "1296724484", "--profile", "steward"]);
      if (kind === "absent") await expect(validationRun).resolves.toBeUndefined();
      else if (kind === "parent-file") await expect(validationRun).rejects.toThrow("WORKFLOW_POLICY: workflow directory type");
      else await expect(validationRun).rejects.toThrow("验证任务失败");
      if (kind === "directory") expect(await readFile(join(workspace, retiredPath, "manual.md"), "utf8")).toBe("人工内容");
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });

  it("只读导出采用同一规则源，不调用网络或写入GitHub", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const network = vi.fn(() => { throw new Error("导出不应访问网络"); });
    vi.stubGlobal("fetch", network);
    vi.stubEnv("STEWARD_CONFIG_DIRECTORY", resolve("config"));
    try {
      await main(["render-review-instructions", "--profile", "common", "--policy-sha", base]);
      const exported = JSON.parse(String(output.mock.calls[0]![0]));
      const { $schema: _p, ...profiles } = JSON.parse(await readFile("config/review/profiles.json", "utf8"));
      const { $schema: _r, ...rules } = JSON.parse(await readFile("config/review/rules.json", "utf8"));
      expect(exported.organization).toEqual(await generateOrganizationReviewInstructions(profiles, rules));
      expect(exported.policySha).toBe(base);
      expect(exported.repository).toEqual(await generateReviewInstructionSet("common", profiles, rules));
      expect(exported.repository.files.map((file: { path: string }) => file.path)).toEqual(["AGENTS.md"]);
      expect(exported.repository.retiredFiles.map((file: { path: string }) => file.path)).toEqual([retiredPath]);
      expect(network).not.toHaveBeenCalled();
    } finally { output.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

});
