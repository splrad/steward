import { describe, expect, it } from "vitest";
import { managedRepositoryTargets, runManagedRepositorySync } from "../src/managed-repository-sync.js";

const catalog = { organization: { id: 1, login: "splrad" }, defaults: { public: { managed: true }, private: { managed: false } }, repositories: { "2": { managed: true, fullName: "splrad/explicit" } } };
const repositories = [
  { id: 2, full_name: "splrad/explicit", private: true, owner: { id: 1, login: "splrad" } },
  { id: 3, full_name: "splrad/inherited", private: false, owner: { id: 1, login: "splrad" } },
  { id: 4, full_name: "splrad/private", private: true, owner: { id: 1, login: "splrad" } },
];

describe("共同受管仓库协调器", () => {
  it("覆盖显式和公开默认登记并在签发目标令牌前忽略private", () => {
    expect(managedRepositoryTargets(catalog, repositories).map(value => [value.repository.id, value.registration, value.managed])).toEqual([[2, "explicit", true], [3, "default-public", true], [4, "default-private", false]]);
  });
  it("单仓选择必须属于安装，且逐仓失败不阻止后续仓", async () => {
    expect(() => managedRepositoryTargets(catalog, repositories, 9)).toThrow("当前安装");
    const targets = managedRepositoryTargets(catalog, repositories);
    const results = await runManagedRepositorySync(targets, async target => {
      if (target.repository.id === 2) throw new Error("failed");
      return "ok";
    });
    expect(results.map(value => value.error ?? value.result ?? value.status)).toEqual(["failed", "ok", "ignored"]);
  });
});
