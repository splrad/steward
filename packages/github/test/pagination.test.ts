import { describe, expect, it } from "vitest";
import { collectAllPages, nextLink } from "../src/pagination.js";

describe("完整分页", () => {
  it("只沿服务端next链接完整分页并冻结结果", async () => {
    const result = await collectAllPages("one", async url => url === "one" ? { items: [1], next: "two" } : { items: [2] });
    expect(result).toEqual([1, 2]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("解析next关系而不使用其他关系", () => {
    const headers = new Headers({ link: '<https://api.test/prev>; rel="prev", <https://api.test/next>; rel="next"' });
    expect(nextLink(headers)).toBe("https://api.test/next");
    expect(nextLink(new Headers())).toBeUndefined();
  });

  it("拒绝循环、页数、项目数和非数组响应", async () => {
    await expect(collectAllPages("one", async () => ({ items: [], next: "one" }))).rejects.toThrow("循环");
    await expect(collectAllPages("one", async url => ({ items: [], next: url === "one" ? "two" : "three" }), { maxPages: 1 })).rejects.toThrow("页数");
    await expect(collectAllPages("one", async () => ({ items: [1, 2] }), { maxItems: 1 })).rejects.toThrow("项目数");
    await expect(collectAllPages("one", async () => ({ items: null as never }))).rejects.toThrow("项目数组");
  });
});
