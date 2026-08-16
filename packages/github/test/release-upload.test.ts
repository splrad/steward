import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { uploadReleaseAsset } from "../src/release-upload.js";

describe("发布资产上传", () => {
  it("校验两种内容类型、字节数、摘要和请求参数", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steward-upload-"));
    try {
      for (const [name, contentType] of [["a.zip", "application/zip"], ["a.exe", "application/x-msdownload"]] as const) {
        const path = join(directory, name);
        const bytes = Buffer.from(name);
        const digest = createHash("sha256").update(bytes).digest("hex");
        await writeFile(path, bytes);
        const value = await uploadReleaseAsset({
          token: "x",
          policySha: "a".repeat(40),
          uploadUrl: "https://example.test/assets{?name}",
          filePath: path,
          fileName: name,
          expectedSha256: digest,
          transport: (async (url: string, init: RequestInit) => {
            expect(url).toBe(`https://example.test/assets?name=${name}`);
            expect(new Headers(init.headers).get("Content-Type")).toBe(contentType);
            expect(new Headers(init.headers).get("Content-Length")).toBe(String(bytes.length));
            return new Response(JSON.stringify({ id: 1, size: bytes.length, digest: `sha256:${digest}` }), { status: 201 });
          }) as typeof fetch,
        });
        expect(value).toMatchObject({ contentType, size: bytes.length, sha256: digest });
      }
      const path = join(directory, "long.zip");
      const bytes = Buffer.from("long");
      const digest = createHash("sha256").update(bytes).digest("hex");
      await writeFile(path, bytes);
      await uploadReleaseAsset({
        token: "x", policySha: "a".repeat(40), uploadUrl: `https://example.test/assets{${"{".repeat(100_000)}`,
        filePath: path, fileName: "long.zip", expectedSha256: digest,
        transport: (async (url: string) => {
          expect(url).toBe("https://example.test/assets?name=long.zip");
          return new Response(JSON.stringify({ size: bytes.length, digest: `sha256:${digest}` }), { status: 201 });
        }) as typeof fetch,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("拒绝本地摘要、类型、上传响应、远程字节数和远程摘要错误", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steward-upload-"));
    const path = join(directory, "a.zip");
    const bytes = Buffer.from("zip");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path, bytes);
    try {
      await expect(uploadReleaseAsset({ token: "x", policySha: "a".repeat(40), uploadUrl: "https://example.test/assets", filePath: path, fileName: "a.zip", expectedSha256: "0".repeat(64) })).rejects.toThrow("摘要");
      await expect(uploadReleaseAsset({ token: "x", policySha: "a".repeat(40), uploadUrl: "https://example.test/assets", filePath: path, fileName: "a.txt", expectedSha256: digest })).rejects.toThrow("类型");
      await expect(uploadReleaseAsset({ token: "x", policySha: "a".repeat(40), uploadUrl: "https://example.test/assets", filePath: path, fileName: "a.zip", expectedSha256: digest, transport: (async () => new Response("failed", { status: 500 })) as typeof fetch })).rejects.toThrow("500");
      await expect(uploadReleaseAsset({ token: "x", policySha: "a".repeat(40), uploadUrl: "https://example.test/assets", filePath: path, fileName: "a.zip", expectedSha256: digest, transport: (async () => new Response(JSON.stringify({ size: 99, digest: `sha256:${digest}` }), { status: 201 })) as typeof fetch })).rejects.toThrow("字节数");
      await expect(uploadReleaseAsset({ token: "x", policySha: "a".repeat(40), uploadUrl: "https://example.test/assets", filePath: path, fileName: "a.zip", expectedSha256: digest, transport: (async () => new Response(JSON.stringify({ size: bytes.length, digest: "sha256:wrong" }), { status: 201 })) as typeof fetch })).rejects.toThrow("远程资产摘要");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
