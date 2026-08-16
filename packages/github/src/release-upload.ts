import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { githubHeaders } from "./api-version.js";

const TYPES: Record<string, string> = { ".exe": "application/x-msdownload", ".zip": "application/zip" };

export async function uploadReleaseAsset(input: {
  token: string; policySha: string; uploadUrl: string; filePath: string; fileName: string; expectedSha256: string; transport?: typeof fetch;
}) {
  const bytes = await readFile(input.filePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== input.expectedSha256.toLowerCase()) throw new Error(`资产摘要不匹配: ${input.fileName}`);
  const extension = input.fileName.slice(input.fileName.lastIndexOf("."));
  const contentType = TYPES[extension];
  if (!contentType) throw new Error(`不支持的资产类型: ${extension}`);
  const base = input.uploadUrl.replace(/\{.*$/, "");
  const response = await (input.transport ?? fetch)(`${base}?name=${encodeURIComponent(input.fileName)}`, {
    method: "POST", headers: { ...githubHeaders(input.token, input.policySha), "Content-Type": contentType, "Content-Length": String(bytes.byteLength) }, body: bytes,
  });
  if (!response.ok) throw new Error(`上传资产失败: ${response.status} ${(await response.text()).slice(0, 500)}`);
  const remote = await response.json() as { size?: number; digest?: string };
  if (remote.size !== undefined && remote.size !== bytes.byteLength) throw new Error(`远程资产字节数不一致: ${input.fileName}`);
  if (remote.digest !== undefined && remote.digest !== `sha256:${digest}`) throw new Error(`远程资产摘要不一致: ${input.fileName}`);
  return { response: remote, sha256: digest, size: bytes.byteLength, contentType };
}
