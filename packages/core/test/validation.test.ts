import { describe, expect, it } from "vitest";
import layerScape from "../../../config/profiles/validation/layerscape.json" with { type: "json" };
import publicBasic from "../../../config/profiles/validation/public-basic.json" with { type: "json" };
import steward from "../../../config/profiles/validation/steward.json" with { type: "json" };
import { renderValidationSummary, runValidationTasks, selectValidationProfile, type ValidationProfile } from "../src/validation.js";

describe("中央验证", () => {
  it("三个配置冻结完整任务清单", () => {
    expect(publicBasic.tasks).toEqual(["git-diff-check", "parse-json", "parse-yaml", "verify-review-instructions", "actionlint-if-present"]);
    expect(layerScape.tasks).toEqual(["git-diff-check", "parse-json", "parse-yaml", "verify-review-instructions", "parse-powershell", "parse-msbuild-xml", "actionlint-if-present"]);
    expect(layerScape.powershellFiles).toEqual(["tools/Publish-ReleaseAssets.ps1"]);
    expect(layerScape.msbuildFiles).toContain("src/**/*.csproj");
    expect(steward.tasks).toEqual(["git-diff-check", "parse-json", "parse-yaml", "verify-review-instructions", "actionlint", "npm-ci", "npm-test", "npm-typecheck", "npm-verify-dist", "npm-verify-workflows"]);
  });

  it("逐项执行、保留失败并诚实披露未构建", async () => {
    const profile: ValidationProfile = { runner: "ubuntu-latest", timeoutMinutes: 10, tasks: ["parse-json", "parse-yaml"], disclosure: { productBuild: "未运行", productTests: "未配置" } };
    const results = await runValidationTasks(profile, async task => {
      if (task === "parse-yaml") throw new Error("无效YAML");
      return { state: "success", detail: "有效" };
    });
    expect(results).toEqual([
      { task: "parse-json", state: "success", detail: "有效" },
      { task: "parse-yaml", state: "failure", detail: "无效YAML" },
    ]);
    const summary = renderValidationSummary(profile, results);
    expect(summary).toContain("❌ parse-yaml: 无效YAML");
    expect(summary).toContain("产品构建：未运行");
    expect(summary).toContain("产品测试：未配置");
  });

  it("按仓库选择配置，私有仓库没有显式配置时拒绝", () => {
    const catalog = { repositories: { "1": { validationProfile: "steward" } }, defaultPublicProfile: "public-basic" };
    expect(selectValidationProfile(1, catalog, false)).toBe("steward");
    expect(selectValidationProfile(2, catalog, false)).toBe("public-basic");
    expect(() => selectValidationProfile(2, catalog, true)).toThrow("私有");
  });

  it("LayerScape只披露真实状态，不把产品构建或测试显示成通过", () => {
    expect(layerScape.disclosure.productBuild).toContain("未运行");
    expect(layerScape.disclosure.productTests).toContain("未配置");
    expect(renderValidationSummary(layerScape as ValidationProfile, [])).toContain("产品只在版本发布时构建");
  });
});
