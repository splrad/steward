import { SignJWT, importPKCS8 } from "jose";
import { GitHubClient } from "./client.js";

export interface InstallationPermissions {
  actions?: "read" | "write";
  administration?: "read" | "write";
  checks?: "read" | "write";
  contents?: "read" | "write";
  issues?: "read" | "write";
  members?: "read";
  metadata?: "read";
  pull_requests?: "read" | "write";
}

export async function createAppJwt(appId: string, privateKey: string, now = Date.now()): Promise<string> {
  const key = await importPKCS8(privateKey.replace(/\\n/g, "\n"), "RS256");
  const issuedAt = Math.floor(now / 1000) - 30;
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(appId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 9 * 60)
    .sign(key);
}

export async function createInstallationToken(input: {
  appId: string;
  privateKey: string;
  installationId: number;
  repositoryId?: number;
  repositoryName?: string;
  permissions: InstallationPermissions;
  policySha: string;
}): Promise<string> {
  if (input.repositoryId !== undefined && input.repositoryName !== undefined) throw new Error("安装令牌仓库范围不能同时使用编号和名称");
  if (input.repositoryName !== undefined && (!/^[A-Za-z0-9_.-]{1,100}$/u.test(input.repositoryName))) throw new Error("安装令牌仓库名称无效");
  const jwt = await createAppJwt(input.appId, input.privateKey);
  const client = new GitHubClient(jwt, "https://api.github.com", fetch, input.policySha);
  const body: Record<string, unknown> = { permissions: input.permissions };
  if (input.repositoryId !== undefined) body.repository_ids = [input.repositoryId];
  if (input.repositoryName !== undefined) body.repositories = [input.repositoryName];
  const result = await client.request<{ token: string }>("POST", `/app/installations/${input.installationId}/access_tokens`, body);
  if (!result.token) throw new Error("GitHub未返回安装令牌");
  return result.token;
}
