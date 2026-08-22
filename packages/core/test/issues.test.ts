import { describe, expect, it } from "vitest";
import {
  analysisInputDigest,
  detectUnmanagedClosingKeywords,
  desiredIssueSetDigest,
  extractIssueLinksBlock,
  issueSnapshotContentDigest,
  managedBodyOutsideIssueLinksDigest,
  normalizeIssueSnapshot,
  openIssueSetDigest,
  removeIssueLinksBlock,
  renderIssueLinksBlock,
  selectDesiredIssueSet,
  upsertIssueLinksBlock,
  validateIssueDecisionEnvelope,
  type IssueCandidate,
  type IssueSnapshotInput,
} from "../src/issues.js";

const repositoryId = 1187527897;
const baseSha = "0".repeat(40);
const headSha = "1".repeat(40);
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

function snapshotInput(overrides: Partial<IssueSnapshotInput> = {}): IssueSnapshotInput {
  return {
    repository: { id: repositoryId, fullName: "splrad/LayerScape" },
    issue: {
      number: 123,
      title: "修复导入失败",
      body: "请参考 ![截图](https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111) 和 [设计说明](https://example.com/design).",
      state: "open",
      labels: ["priority:high", "bug"],
      milestone: null,
      stateReason: null,
      issueType: "Bug",
      fieldValues: [{ name: "Severity", type: "single_select", value: "High" }],
      createdAt: "2026-08-19T00:00:00Z",
      updatedAt: "2026-08-19T01:00:00Z",
      commentsCount: 2,
    },
    comments: [
      { id: 20, author: "two", body: '<img src="https://cdn.example.com/repro.png">', createdAt: "2026-08-19T00:30:00Z", updatedAt: "2026-08-19T00:31:00Z" },
      { id: 10, author: "one", body: "日志：[下载](https://example.com/repro.zip)", createdAt: "2026-08-19T00:20:00Z", updatedAt: "2026-08-19T00:20:00Z" },
    ],
    parent: null,
    subIssues: [],
    blockedBy: [],
    blocking: [],
    ...overrides,
  };
}

describe("议题核心合同", () => {
  it("规范化固定事实、稳定排序并只保存未抓取URL摘要", () => {
    const snapshot = normalizeIssueSnapshot(snapshotInput());
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.issue.labels).toEqual(["bug", "priority:high"]);
    expect(snapshot.comments.map((comment) => comment.id)).toEqual([10, 20]);
    expect(snapshot.unfetchedReferences.map((reference) => reference.type).sort()).toEqual(["document", "file", "image", "image"]);
    expect(snapshot.unfetchedReferences.every((reference) => /^[0-9a-f]{64}$/.test(reference.urlDigest))).toBe(true);
    expect(snapshot.unfetchedReferences.every((reference) => !Object.hasOwn(reference, "url"))).toBe(true);
    expect(issueSnapshotContentDigest(snapshot)).toMatch(/^[0-9a-f]{64}$/);
    expect(issueSnapshotContentDigest(normalizeIssueSnapshot(snapshotInput()))).toBe(issueSnapshotContentDigest(snapshot));
  });

  it("以线性扫描处理长尾标点、Markdown和尖括号链接", () => {
    const tail = "]".repeat(100_000);
    const value = normalizeIssueSnapshot(snapshotInput({
      issue: { ...snapshotInput().issue, body: `![图](https://example.com/image.png) <https://example.com/doc>${tail}`, commentsCount: 0 },
      comments: [],
    }));
    expect(value.unfetchedReferences).toHaveLength(2);
    expect(value.unfetchedReferences.map(reference => reference.type).sort()).toEqual(["document", "image"]);
  });

  it("拒绝非固定字段、不完整评论和超过256 KiB的快照", () => {
    const withExtra = snapshotInput() as IssueSnapshotInput & { extra?: boolean };
    withExtra.extra = true;
    expect(() => normalizeIssueSnapshot(withExtra)).toThrow("额外字段");
    expect(() => normalizeIssueSnapshot(snapshotInput({ issue: { ...snapshotInput().issue, commentsCount: 1 } }))).toThrow("评论数量");
    expect(() => normalizeIssueSnapshot(snapshotInput({ issue: { ...snapshotInput().issue, body: "x".repeat(300_000) } }))).toThrow("256 KiB");
  });

  it("摘要绑定仓库、开放集合、输入和目标集合且不受输入顺序影响", () => {
    expect(openIssueSetDigest(repositoryId, [2, 1])).toBe(openIssueSetDigest(repositoryId, [1, 2]));
    expect(openIssueSetDigest(repositoryId, [1])).not.toBe(openIssueSetDigest(1296724484, [1]));
    expect(desiredIssueSetDigest([{ repositoryId, number: 2 }, { repositoryId, number: 1 }]))
      .toBe(desiredIssueSetDigest([{ repositoryId, number: 1 }, { repositoryId, number: 2 }]));
    const input = {
      repositoryId,
      pullRequestNumber: 42,
      baseSha,
      headSha,
      generation: 17,
      policySha: headSha,
      fullDiffDigest: digestA,
      candidateDigests: [{ repositoryId, number: 2, contentDigest: digestB }, { repositoryId, number: 1, contentDigest: digestA }],
      openSetDigest: digestB,
      unmanagedBodyDigest: digestA,
    };
    expect(analysisInputDigest(input)).toBe(analysisInputDigest({ ...input, candidateDigests: [...input.candidateDigests].reverse() }));
    expect(() => openIssueSetDigest(repositoryId, [1, 1])).toThrow("重复");
  });

  it("只选择同仓开放、无未抓取引用且证据完整的resolves/high决策", () => {
    const envelope = validateIssueDecisionEnvelope({
      issueDecisions: [
        {
          repositoryId,
          number: 123,
          decision: "resolves",
          confidence: "high",
          requirements: ["导入失败时返回明确错误"],
          evidence: [{ requirement: 0, files: ["packages/core/src/issues.ts"], explanation: "新增固定校验并返回安全错误" }],
          unresolved: [],
        },
        {
          repositoryId,
          number: 124,
          decision: "related",
          confidence: "high",
          requirements: ["记录后续想法"],
          evidence: [{ requirement: 0, files: ["packages/core/src/issues.ts"], explanation: "只存在相关改动，未完整解决" }],
          unresolved: ["仍需后续实现"],
        },
      ],
    });
    const candidates: IssueCandidate[] = [
      { repositoryId, number: 123, state: "open", contentDigest: digestA, unfetchedReferences: [] },
      { repositoryId, number: 124, state: "open", contentDigest: digestB, unfetchedReferences: [] },
    ];
    expect(selectDesiredIssueSet(envelope, { targetRepositoryId: repositoryId, candidates, changedFiles: ["packages/core/src/issues.ts"] }))
      .toEqual([{ repositoryId, number: 123 }]);
    expect(selectDesiredIssueSet(envelope, {
      targetRepositoryId: repositoryId,
      candidates: [{ ...candidates[0]!, unfetchedReferences: [{ source: "issue.body", line: 1, type: "document", urlDigest: digestA }] }, candidates[1]!],
      changedFiles: ["packages/core/src/issues.ts"],
    })).toEqual([]);
    expect(() => selectDesiredIssueSet(envelope, { targetRepositoryId: 1296724484, candidates, changedFiles: ["packages/core/src/issues.ts"] })).toThrow("issue-repository-mismatch");
    expect(() => validateIssueDecisionEnvelope({ issueDecisions: [{ ...envelope.issueDecisions[0], evidence: [] }] })).toThrow("evidence");
    expect(selectDesiredIssueSet(validateIssueDecisionEnvelope({ issueDecisions: [{ ...envelope.issueDecisions[0], evidence: [{ requirement: 0, files: ["unknown.ts"], explanation: "引用未改动文件作为证据" }] }] }), { targetRepositoryId: repositoryId, candidates, changedFiles: ["packages/core/src/issues.ts"] })).toEqual([]);
    expect(() => validateIssueDecisionEnvelope({ issueDecisions: [{ ...envelope.issueDecisions[0], requirements: ["Resolves #123"], evidence: [{ requirement: 0, files: ["packages/core/src/issues.ts"], explanation: "错误返回关闭关键字" }] }] })).toThrow("关闭关键字");
    expect(() => validateIssueDecisionEnvelope({ issueDecisions: [envelope.issueDecisions[0], envelope.issueDecisions[0]] })).toThrow("重复");
    expect(() => validateIssueDecisionEnvelope({ issueDecisions: [{ ...envelope.issueDecisions[0], extra: true }] })).toThrow("额外字段");
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

  it("只忽略合法受管块内的关闭关键字，拒绝正文块外和提交消息关闭路径", () => {
    const block = renderIssueLinksBlock({ repositoryId, pullRequestNumber: 42, baseSha, headSha, generation: 17, analysisInputDigest: digestA }, [{ repositoryId, number: 123 }]);
    const outer = upsertIssueLinksBlock('<!-- workflow:managed-pr:start -->\n## 摘要\n\n正文\n\n<!-- workflow:source-actor:bot -->\n<!-- workflow:managed-pr:end -->\n', block);
    expect(detectUnmanagedClosingKeywords({ body: outer, commitMessages: ["feat: 普通提交"] })).toEqual([]);
    expect(detectUnmanagedClosingKeywords({ body: `${outer}\nFixes splrad/LayerScape#99`, commitMessages: ["Resolves #88"] }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "body", issueReference: "splrad/LayerScape#99" }),
        expect.objectContaining({ source: "commit", issueReference: "#88" }),
      ]));
  });
});
