import { describe, expect, it } from "vitest";
import profile from "../../../config/profiles/release/layerscape.json" with { type: "json" };
import { classifyRemoteReleaseState, parseVersion, planRelease, verifyAssetManifest } from "../src/release.js";

const targetSha = "a".repeat(40);
const policySha = "b".repeat(40);
const assets = [
  { name: "AFR-Deployer_v2.0.0.exe", size: 1, sha256: "1".repeat(64) },
  { name: "AFR-DLL_v2.0.0.zip", size: 2, sha256: "2".repeat(64) },
  { name: "Fonts.zip", size: 3, sha256: "3".repeat(64) },
];
const matching = { id: 7, draft: true, prerelease: false, targetMatches: true, titleMatches: true, markerMatches: true, assetsMatch: false, hasUnexpectedAssets: false };

describe("中央发布", () => {
  it("要求版本和构建编号格式正确且同时严格增长", () => {
    const next = parseVersion("2.0.0", "20260816.1");
    const previous = parseVersion("1.9.9", "20260815.1");
    expect(planRelease({ next, previous, targetSha })).toEqual({ tag: "v2.0.0", title: "AFR v2.0.0 (20260816.1)", targetSha });
    for (const [displayVersion, buildId] of [["2.0", "20260816.1"], ["2.0.0", "2026.1"]] as const) {
      expect(() => parseVersion(displayVersion, buildId)).toThrow();
    }
    expect(() => planRelease({ next, previous: parseVersion("2.0.0", "20260815.1"), targetSha })).toThrow("严格增长");
    expect(() => planRelease({ next, previous: parseVersion("1.9.9", "20260817.1"), targetSha })).toThrow("严格增长");
    expect(() => planRelease({ next, previous, targetSha: "short" })).toThrow("40位");
  });

  it("冻结十个插件、部署器和恰好三项资产", () => {
    expect(profile.build.projects.map(value => value.path)).toEqual(Array.from({ length: 10 }, (_, index) => {
      const year = 2018 + index;
      return `src/AutoCAD/AFR-ACAD${year}/AFR-ACAD${year}.csproj`;
    }));
    expect(profile.build.deployer.path).toBe("src/AFR.Deployer/AFR.Deployer.csproj");
    expect(profile.assets.map(value => value.nameTemplate)).toEqual(["AFR-Deployer_v{displayVersion}.exe", "AFR-DLL_v{displayVersion}.zip", "Fonts.zip"]);
    expect(profile.release.requireImmutablePolicy).toBe(true);
  });

  it("只接受基础字段、名称、大小和摘要全部正确的三资产清单", () => {
    const manifest = { schemaVersion: 1 as const, repositoryId: 1187527897, targetSha, policySha, displayVersion: "2.0.0", buildId: "20260816.1", assets };
    expect(() => verifyAssetManifest(manifest, assets.map(value => value.name))).not.toThrow();
    expect(() => verifyAssetManifest({ ...manifest, assets: assets.slice(0, 2) }, assets.map(value => value.name))).toThrow("数量");
    expect(() => verifyAssetManifest({ ...manifest, assets: [{ ...assets[0]!, size: 0 }, ...assets.slice(1)] }, assets.map(value => value.name))).toThrow();
    expect(() => verifyAssetManifest({ ...manifest, assets: [{ ...assets[0]!, sha256: "x" }, ...assets.slice(1)] }, assets.map(value => value.name))).toThrow();
    expect(() => verifyAssetManifest({ ...manifest, policySha: "short" }, assets.map(value => value.name))).toThrow("基础字段");
  });

  it("完整覆盖远程草稿、已发布幂等和冲突状态表", () => {
    expect(classifyRemoteReleaseState({ tagExists: false })).toEqual({ state: "create-draft" });
    expect(classifyRemoteReleaseState({ tagExists: true })).toEqual({ state: "conflict", reason: "标签存在但发布不存在" });
    expect(classifyRemoteReleaseState({ tagExists: false, release: matching })).toEqual({ state: "conflict", reason: "发布存在但标签不存在" });
    expect(classifyRemoteReleaseState({ tagExists: true, release: matching })).toEqual({ state: "resume-draft", releaseId: 7 });
    expect(classifyRemoteReleaseState({ tagExists: true, release: { ...matching, draft: false, assetsMatch: true } })).toEqual({ state: "already-complete", releaseId: 7 });
    for (const patch of [
      { prerelease: true },
      { targetMatches: false },
      { titleMatches: false },
      { markerMatches: false },
      { hasUnexpectedAssets: true },
    ]) expect(classifyRemoteReleaseState({ tagExists: true, release: { ...matching, ...patch } }).state).toBe("conflict");
    expect(classifyRemoteReleaseState({ tagExists: true, release: { ...matching, draft: false, assetsMatch: false } })).toEqual({ state: "conflict", reason: "已发布资产不一致" });
  });
});
