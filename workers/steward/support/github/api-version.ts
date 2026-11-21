export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_ACCEPT = "application/vnd.github+json";

export function githubHeaders(token: string, policySha: string): HeadersInit {
  if (!/^[0-9a-f]{40}$/i.test(policySha)) throw new Error("policySha必须是40位提交编号");
  return {
    Accept: GITHUB_ACCEPT,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": `splrad-steward/${policySha.toLowerCase()}`,
  };
}
