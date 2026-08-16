import { githubHeaders } from "./api-version.js";
import { collectAllPages, nextLink } from "./pagination.js";

const encodeGitReferencePath = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

export class GitHubRequestError extends Error {
  constructor(public readonly status: number, public readonly method: string, public readonly path: string, message: string) {
    super(`${method} ${path}: ${status} ${message}`);
  }
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = "https://api.github.com",
    private readonly transport: typeof fetch = fetch,
    private readonly policySha = "0".repeat(40),
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;
    const headers = new Headers(githubHeaders(this.token, this.policySha));
    const init: RequestInit = { method, headers };
    if (body !== undefined) { headers.set("Content-Type", "application/json"); init.body = JSON.stringify(body); }
    const response = await this.transport.call(globalThis, url, init);
    if (!response.ok) {
      const text = (await response.text()).slice(0, 1000);
      throw new GitHubRequestError(response.status, method, path, text || response.statusText);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async paginate<T>(path: string, select: (value: unknown) => readonly T[] = value => value as readonly T[]): Promise<readonly T[]> {
    return collectAllPages(path, async url => {
      const absolute = url.startsWith("http") ? url : `${this.apiBase}${url}`;
      const response = await this.transport.call(globalThis, absolute, { headers: githubHeaders(this.token, this.policySha) });
      if (!response.ok) throw new GitHubRequestError(response.status, "GET", url, await response.text());
      const value = await response.json();
      const next = nextLink(response.headers);
      return next ? { items: select(value), next } : { items: select(value) };
    });
  }

  getRepository(owner: string, repo: string) { return this.request<any>("GET", `/repos/${owner}/${repo}`); }
  getRepositoryById(id: number) { return this.request<any>("GET", `/repositories/${id}`); }
  getPullRequest(owner: string, repo: string, number: number) { return this.request<any>("GET", `/repos/${owner}/${repo}/pulls/${number}`); }
  listPullRequests(owner: string, repo: string, head: string) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=100`); }
  listOpenPullRequests(owner: string, repo: string, base: string) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`); }
  createPullRequest(owner: string, repo: string, body: unknown) { return this.request<any>("POST", `/repos/${owner}/${repo}/pulls`, body); }
  updatePullRequest(owner: string, repo: string, number: number, body: unknown) { return this.request<any>("PATCH", `/repos/${owner}/${repo}/pulls/${number}`, body); }
  compare(owner: string, repo: string, base: string, head: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`); }
  getCommit(owner: string, repo: string, ref: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`); }
  listPullFiles(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`); }
  listPullCommits(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`); }
  listLabels(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/issues/${number}/labels?per_page=100`); }
  setLabels(owner: string, repo: string, number: number, labels: readonly string[]) { return this.request<any>("POST", `/repos/${owner}/${repo}/issues/${number}/labels`, { labels }); }
  getLabel(owner: string, repo: string, name: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`); }
  createLabel(owner: string, repo: string, body: unknown) { return this.request<any>("POST", `/repos/${owner}/${repo}/labels`, body); }
  updateLabel(owner: string, repo: string, name: string, body: unknown) { return this.request<any>("PATCH", `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, body); }
  listCheckRuns(owner: string, repo: string, ref: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`); }
  listAllCheckRuns(owner: string, repo: string, ref: string) { return this.paginate<any>(`/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`, value => (value as any).check_runs); }
  createCheckRun(owner: string, repo: string, body: unknown) { return this.request<any>("POST", `/repos/${owner}/${repo}/check-runs`, body); }
  updateCheckRun(owner: string, repo: string, id: number, body: unknown) { return this.request<any>("PATCH", `/repos/${owner}/${repo}/check-runs/${id}`, body); }
  getRequestedReviewers(owner: string, repo: string, number: number) { return this.request<any>("GET", `/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`); }
  listPullRequestReviews(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`); }
  requestReviewers(owner: string, repo: string, number: number, reviewers: readonly string[]) { return this.request<any>("POST", `/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, { reviewers }); }
  updateRepository(owner: string, repo: string, body: unknown) { return this.request<any>("PATCH", `/repos/${owner}/${repo}`, body); }
  getRef(owner: string, repo: string, ref: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/git/ref/${encodeGitReferencePath(ref)}`); }
  getContent(owner: string, repo: string, path: string, ref?: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`); }
  putContent(owner: string, repo: string, path: string, body: unknown) { return this.request<any>("PUT", `/repos/${owner}/${repo}/contents/${path}`, body); }
  createRef(owner: string, repo: string, ref: string, sha: string) { return this.request<any>("POST", `/repos/${owner}/${repo}/git/refs`, { ref, sha }); }
  updateRef(owner: string, repo: string, ref: string, sha: string, force = false) { return this.request<any>("PATCH", `/repos/${owner}/${repo}/git/refs/${encodeGitReferencePath(ref)}`, { sha, force }); }
  createRelease(owner: string, repo: string, body: unknown) { return this.request<any>("POST", `/repos/${owner}/${repo}/releases`, body); }
  updateRelease(owner: string, repo: string, id: number, body: unknown) { return this.request<any>("PATCH", `/repos/${owner}/${repo}/releases/${id}`, body); }
  getReleaseByTag(owner: string, repo: string, tag: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`); }
  getLatestRelease(owner: string, repo: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/releases/latest`); }
  listReleases(owner: string, repo: string) { return this.paginate<any>(`/repos/${owner}/${repo}/releases?per_page=100`); }
  listPullsForCommit(owner: string, repo: string, sha: string) { return this.paginate<any>(`/repos/${owner}/${repo}/commits/${sha}/pulls?per_page=100`); }
  getGitRef(owner: string, repo: string, ref: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/git/ref/${encodeGitReferencePath(ref)}`); }
  getGitTag(owner: string, repo: string, sha: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/git/tags/${sha}`); }
  getImmutableReleaseStatus(owner: string, repo: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/immutable-releases`); }
  listOrganizationRepositories(owner: string) { return this.paginate<any>(`/orgs/${owner}/repos?type=all&per_page=100`); }
  listRepositoryTeams(owner: string, repo: string) { return this.paginate<any>(`/repos/${owner}/${repo}/teams?per_page=100`); }
  listRepositoryRulesets(owner: string, repo: string) { return this.paginate<any>(`/repos/${owner}/${repo}/rulesets?includes_parents=true&per_page=100`); }
  getTeamMembership(owner: string, teamSlug: string, username: string) { return this.request<any>("GET", `/orgs/${owner}/teams/${teamSlug}/memberships/${username}`); }
  deleteReleaseAsset(owner: string, repo: string, id: number) { return this.request<void>("DELETE", `/repos/${owner}/${repo}/releases/assets/${id}`); }
}
