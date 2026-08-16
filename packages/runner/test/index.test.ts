import { readFile, stat } from "node:fs/promises";
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import { classificationInstallationPermissions, env, isCopilotReviewerIdentity, parseInvocation } from "../src/index.js";

const Ajv = AjvModule as unknown as typeof import("ajv").default;
const addFormats = addFormatsModule as unknown as typeof import("ajv-formats").default;

afterEach(() => {
  delete process.env.TEST_REQUIRED_ENV;
});

describe("中央命令入口", () => {
  it("只接受九个命令及其已知、唯一、成对参数", () => {
    const commands = ["onboard-repository", "pr-automation", "pr-classification", "sync-copilot-instructions", "validate", "release-preflight", "release-notes", "release-publish", "release-verify"];
    for (const command of commands) expect(parseInvocation([command]).command).toBe(command);
    expect(() => parseInvocation(["unknown"])).toThrow("未知命令");
    expect(() => parseInvocation(["validate", "--unknown", "x"])).toThrow("未知参数");
    expect(() => parseInvocation(["validate", "--workspace"])).toThrow("参数格式");
    expect(() => parseInvocation(["validate", "--workspace", "a", "--workspace", "b"])).toThrow("重复参数");
  });

  it("缺失环境变量立即失败", () => {
    expect(() => env("TEST_REQUIRED_ENV")).toThrow("缺少环境变量");
    process.env.TEST_REQUIRED_ENV = "present";
    expect(env("TEST_REQUIRED_ENV")).toBe("present");
  });

  it("识别平台实际返回的Copilot身份并给分类令牌完整的拉取请求写权限", () => {
    for (const identity of ["Copilot", "copilot", "copilot-pull-request-reviewer", "copilot-pull-request-reviewer[bot]"]) {
      expect(isCopilotReviewerIdentity(identity)).toBe(true);
    }
    for (const identity of ["copilot-agent[bot]", "splrad-steward[bot]", "maintainers", ""]) {
      expect(isCopilotReviewerIdentity(identity)).toBe(false);
    }
    expect(classificationInstallationPermissions()).toEqual({
      contents: "read",
      pull_requests: "write",
      issues: "write",
      checks: "write",
      metadata: "read",
    });
  });

  it("四个结构文件接受全部中央配置并拒绝额外字段", async () => {
    const pairs = [
      ["config/repositories.json", "schema/repositories.schema.json"],
      ["config/profiles/classification/default.json", "schema/classification-profile.schema.json"],
      ["config/profiles/classification/layerscape.json", "schema/classification-profile.schema.json"],
      ["config/profiles/validation/public-basic.json", "schema/validation-profile.schema.json"],
      ["config/profiles/validation/layerscape.json", "schema/validation-profile.schema.json"],
      ["config/profiles/validation/steward.json", "schema/validation-profile.schema.json"],
      ["config/profiles/release/layerscape.json", "schema/release-profile.schema.json"],
    ] as const;
    for (const [dataPath, schemaPath] of pairs) {
      const ajv = new Ajv({ allErrors: true, strict: true });
      addFormats(ajv);
      const data = JSON.parse(await readFile(dataPath, "utf8"));
      const schema = JSON.parse(await readFile(schemaPath, "utf8"));
      const validate = ajv.compile(schema);
      expect(validate(data), dataPath).toBe(true);
      const invalid = structuredClone(data);
      invalid.unexpectedField = true;
      expect(validate(invalid), `${dataPath}反例`).toBe(false);
    }
  });

  it("中央配置黄金事实逐字冻结", async () => {
    const repositories = JSON.parse(await readFile("config/repositories.json", "utf8"));
    const release = JSON.parse(await readFile("config/profiles/release/layerscape.json", "utf8"));
    expect(repositories.organization).toEqual({ id: 302208797, login: "splrad" });
    expect(repositories.defaults.public).toMatchObject({ managed: true, prAutomation: true, validationProfile: "public-basic", releaseProfile: null });
    expect(Object.keys(repositories.repositories).sort()).toEqual(["1187527897", "1296724484", "1296725317"]);
    expect(release.build.projects.map((value: any) => value.path)).toEqual(Array.from({ length: 10 }, (_, index) => {
      const year = 2018 + index;
      return `src/AutoCAD/AFR-ACAD${year}/AFR-ACAD${year}.csproj`;
    }));
    expect(release.assets.map((value: any) => value.nameTemplate)).toEqual(["AFR-Deployer_v{displayVersion}.exe", "AFR-DLL_v{displayVersion}.zip", "Fonts.zip"]);
    expect(release.releaseNotes.excludedLabels).toEqual(["ignore-for-release", "skip-changelog", "no-changelog", "no-release-notes"]);
  });

  it("实现冻结完整比较、唯一拉取请求、漂移和同名检查失败保护", async () => {
    const source = await readFile("packages/runner/src/index.ts", "utf8");
    for (const fragment of [
      "提交比较结果未完整返回",
      "文件比较达到接口上限",
      "同一来源分支存在多个匹配拉取请求",
      "读取期间来源或目标分支已经漂移",
      "人工智能输入对应的分支事实已经漂移",
      "同名分类检查存在歧义",
      "分类输入在写入期间已经漂移",
      "LayerScape不可变发布尚未启用",
      "当前默认分支第一父提交链",
    ]) expect(source).toContain(fragment);
    expect(source).not.toMatch(/heads\/main|base\.ref\s*!==\s*"main"|default_branch\s*!==\s*"main"/u);
  });

  it("终态没有普通评论写入、旧包或旧运行目录", async () => {
    const sourceFiles = [
      "packages/runner/src/index.ts",
      "packages/runtime/src/index.ts",
      "packages/github/src/client.ts",
      "packages/core/src/automation.ts",
    ];
    const source = (await Promise.all(sourceFiles.map(path => readFile(path, "utf8")))).join("\n");
    expect(source).not.toMatch(/createComment|updateComment|issue_comment|issues\/[^/]+\/comments/iu);
    for (const path of [
      "action",
      "packages/access-auth",
      "packages/cli",
      "packages/control",
      "packages/control-runtime",
      "packages/coordinator",
      "packages/diagnostics",
      "packages/ingress",
      "packages/manifest",
      "packages/promotion",
      "packages/recovery",
      "packages/relay",
    ]) await expect(stat(path)).rejects.toThrow();
  });

  it("工作流摘要代码不输出密钥或令牌值", async () => {
    const source = await readFile("packages/runner/src/index.ts", "utf8");
    const summaries = source.split("\n").filter(line => line.includes("summary([")).join("\n");
    expect(summaries).not.toMatch(/STEWARD_APP_PRIVATE_KEY|COPILOT_REVIEW_REQUEST_TOKEN|installation-token|upload_url/iu);
  });
});
