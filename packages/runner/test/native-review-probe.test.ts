import { describe, expect, it } from "vitest";
import { caseSensitivePathExample, duplicatePathExample, emptyPathExample, singlePathExample, summarizeChangedPaths } from "../../../validation/native-review-probe.js";

describe("原生审查验证样本", () => {
  it("空字符串路径作为普通字符串去重并保留", () => {
    expect(summarizeChangedPaths(["", "a.ts", ""])).toEqual({ fileCount: 2, paths: ["", "a.ts"] });
  });
  it("单路径样本保留路径并返回数量一", () => {
    expect(singlePathExample).toEqual({ fileCount: 1, paths: ["src/only.ts"] });
  });
  it("保留大小写不同的路径并按字符串顺序排列", () => {
    expect(caseSensitivePathExample).toEqual({ fileCount: 2, paths: ["src/A.ts", "src/a.ts"] });
  });
  it("重复路径样本返回去重、排序后的路径及准确数量", () => {
    expect(duplicatePathExample).toEqual({ fileCount: 2, paths: ["a.ts", "b.ts"] });
  });

  it("空输入样本返回零数量及空列表", () => {
    expect(emptyPathExample).toEqual({ fileCount: 0, paths: [] });
  });

  it("汇总只读输入时保持原有路径和顺序", () => {
    const input = Object.freeze(["z.ts", "c.ts", "z.ts"]);
    expect(summarizeChangedPaths(input)).toEqual({ fileCount: 2, paths: ["c.ts", "z.ts"] });
    expect(input).toEqual(["z.ts", "c.ts", "z.ts"]);
  });
});
