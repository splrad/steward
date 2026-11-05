export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_ACCEPT = "application/vnd.github+json";

export function githubHeaders(token: string): HeadersInit {
  return {
    Accept: GITHUB_ACCEPT,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "splrad-steward",
  };
}
