import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";
afterEach(() => vi.unstubAllGlobals());
describe("退役自动化入口", () => {
  it.each(["pr-automation", "issue-sync", "pr-issue-link", "reconcile-repository-lifecycle"])("%s 在读取凭据及网络前拒绝运行", async command => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(main([command])).rejects.toThrow("未知命令");
    expect(fetch).not.toHaveBeenCalled();
  });
});
