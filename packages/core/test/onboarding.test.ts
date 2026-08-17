import { describe, expect, it } from "vitest";
import { organizationPullRequestTemplate } from "../src/automation.js";
import { planRepositorySettings, renderOnboardingPullRequest, validateRepositoryForOnboarding, verifyOnboardingReadback } from "../src/onboarding.js";

const publicRepository = { id: 1, fullName: "splrad/new", ownerId: 302208797, visibility: "public" as const, fork: false, archived: false, disabled: false, defaultBranch: "main" };
const configured = { managed: true, copilotInstructionsProfile: "common", classificationProfile: "default", validationProfile: "public-basic", releaseProfile: null };

describe("新仓库接入", () => {
  it("公开组织仓库可接入并固定五项设置", () => {
    expect(validateRepositoryForOnboarding(publicRepository, 302208797, configured)).toBe("ready");
    expect(planRepositorySettings()).toEqual({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: false, delete_branch_on_merge: true });
  });

  it("空仓库等待首次默认分支推送", () => {
    expect(validateRepositoryForOnboarding({ ...publicRepository, defaultBranch: null }, 302208797, configured)).toBe("waiting-for-default-branch");
  });

  it("拒绝错误组织、派生、归档、禁用、未纳管和未配置私有仓库", () => {
    expect(() => validateRepositoryForOnboarding({ ...publicRepository, ownerId: 1 }, 302208797, configured)).toThrow("组织");
    expect(() => validateRepositoryForOnboarding({ ...publicRepository, fork: true }, 302208797, configured)).toThrow("派生");
    expect(() => validateRepositoryForOnboarding({ ...publicRepository, archived: true }, 302208797, configured)).toThrow("归档");
    expect(() => validateRepositoryForOnboarding({ ...publicRepository, disabled: true }, 302208797, configured)).toThrow("禁用");
    expect(() => validateRepositoryForOnboarding(publicRepository, 302208797, { managed: false })).toThrow("纳管");
    expect(() => validateRepositoryForOnboarding({ ...publicRepository, visibility: "private" }, 302208797, { managed: true })).toThrow("私有");
    expect(validateRepositoryForOnboarding({ ...publicRepository, visibility: "private" }, 302208797, configured)).toBe("ready");
  });

  it("生成唯一接入分支、完整标题和无普通评论的拉取请求正文", () => {
    const value = renderOnboardingPullRequest({ template: organizationPullRequestTemplate, configuration: configured, actor: "splrad-steward[bot]", context: "a".repeat(64) });
    expect(value.branch).toBe("steward/repository-onboarding");
    expect(value.title).toBe("chore(steward): 接入中央仓库管理");
    expect(value.body).toContain("## 摘要");
    expect(value.body).toContain("## 背景与目标");
    expect(value.body).toContain("## 影响分析");
    expect(value.body).not.toContain("## 发布与迁移");
    expect(value.body).not.toContain("人工补充");
    expect(value.body).not.toContain("## 贡献者");
    expect(value.body).not.toContain("issue_comment");
  });

  it("读回完全一致时通过，任一设置、说明或工作流越界时失败", () => {
    const settings = planRepositorySettings();
    expect(verifyOnboardingReadback(settings, "expected", "expected", ["allowed.yml"], ["allowed.yml"])).toBe(true);
    expect(verifyOnboardingReadback({ ...settings, allow_auto_merge: true as never }, "expected", "expected", [], [])).toBe(false);
    expect(verifyOnboardingReadback(settings, "expected", "different", [], [])).toBe(false);
    expect(verifyOnboardingReadback(settings, "expected", "expected", ["unexpected.yml"], [])).toBe(false);
  });
});
