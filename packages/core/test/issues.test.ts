import { describe, expect, it } from "vitest";
import { extractIssueLinksBlock, isStewardOwnedPullRequest, managedBodyOutsideIssueLinksDigest, removeIssueLinksBlock, renderIssueLinksBlock, upsertIssueLinksBlock } from "../src/issues.js";
const repositoryId = 1187527897;
const baseSha = "0".repeat(40), headSha = "1".repeat(40), digestA = "a".repeat(64), digestB = "b".repeat(64);
describe("历史正文区域保真", () => {
  it("Steward PR 身份同时绑定作者和源目标仓库", () => {
    const pull = { user: { id: 301115370 }, head: { repo: { id: repositoryId } }, base: { repo: { id: repositoryId } } };
    expect(isStewardOwnedPullRequest(pull, repositoryId)).toBe(true);
    expect(isStewardOwnedPullRequest({ ...pull, user: { id: 1 } }, repositoryId)).toBe(false);
    expect(isStewardOwnedPullRequest(pull, 1)).toBe(false);
  });
  it("渲染、替换和解析唯一内层块，并保持块外字节摘要不变", () => {
    const metadata = { repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 17, analysisInputDigest: digestA };
    const first = renderIssueLinksBlock(metadata, [{ repositoryId, number: 456 }, { repositoryId, number: 123 }]);
    expect(first).toContain("## 解决的议题\n\nResolves #123\nResolves #456");
    expect(extractIssueLinksBlock(first)?.metadata.issueNumbers).toEqual([123, 456]);
    const outer = '<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n## 影响分析\n\n无\n\n## 发布与迁移\n\n无\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n';
    const inserted = upsertIssueLinksBlock(outer, first);
    expect(inserted.indexOf("## 影响分析")).toBeLessThan(inserted.indexOf("## 解决的议题"));
    expect(inserted.indexOf("## 解决的议题")).toBeLessThan(inserted.indexOf("## 发布与迁移"));
    const outsideDigest = managedBodyOutsideIssueLinksDigest(inserted);
    expect(outsideDigest).toBe(managedBodyOutsideIssueLinksDigest(outer));
    const empty = renderIssueLinksBlock({ ...metadata, generation: 18, analysisInputDigest: digestB }, []);
    const replaced = upsertIssueLinksBlock(inserted, empty);
    expect(replaced).not.toContain("## 解决的议题");
    expect(replaced).not.toContain("Resolves #");
    expect(managedBodyOutsideIssueLinksDigest(replaced)).toBe(outsideDigest);
    expect(removeIssueLinksBlock(inserted)).toBe(outer);
    expect(removeIssueLinksBlock(outer)).toBe(outer);
    const legacyOuter = '<!-- workflow:auto-summary:start -->\n## 摘要\n\n旧版正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:auto-summary:end -->\n';
    const legacyInserted = upsertIssueLinksBlock(legacyOuter, first);
    expect(extractIssueLinksBlock(legacyInserted)?.metadata.issueNumbers).toEqual([123, 456]);
    expect(removeIssueLinksBlock(legacyInserted)).toBe(legacyOuter);
    expect(managedBodyOutsideIssueLinksDigest(upsertIssueLinksBlock(legacyInserted, empty))).toBe(managedBodyOutsideIssueLinksDigest(legacyInserted));
    const damagedMetadata = inserted.replace('generation=17', 'generation=broken');
    const damagedContent = inserted.replace('Resolves #123', 'Resolves issue 123');
    expect(() => extractIssueLinksBlock(damagedMetadata)).toThrow('字段无效');
    expect(() => extractIssueLinksBlock(damagedContent)).toThrow('关闭关键字无效');
    expect(removeIssueLinksBlock(damagedMetadata)).toBe(outer);
    expect(removeIssueLinksBlock(damagedContent)).toBe(outer);
    expect(() => upsertIssueLinksBlock(`${inserted}\n${first}`, empty)).toThrow("重复");
    expect(() => upsertIssueLinksBlock(`${outer}${legacyOuter}`, empty)).toThrow("外层");
    expect(() => upsertIssueLinksBlock(outer.replace("## 摘要", `${first}\n## 摘要`).replace("<!-- workflow:managed-pr:start -->\n", ""), empty)).toThrow("外层");
    expect(() => managedBodyOutsideIssueLinksDigest(`${first}\n${outer}`)).toThrow("外层");
  });

});
