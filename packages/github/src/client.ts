import { githubHeaders } from "./api-version.js";
import { collectAllPages, nextLink } from "./pagination.js";

const encodeGitReferencePath = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

export type IssueFactResource = "issue" | "comments" | "field-values" | "parent" | "sub-issues" | "blocked-by" | "blocking" | "open-issues";

export interface PageValidator {
  resource: IssueFactResource;
  url: string;
  etag: string | null;
  next: string | null;
  status: 200 | 404;
}

export interface ValidatedValue<T> { value: T; validator: PageValidator }
export interface ValidatedCollection<T> { items: readonly T[]; validators: readonly PageValidator[] }
export interface GitHubIssueFacts {
  issue: any;
  comments: readonly any[];
  fieldValues: readonly any[];
  parent: any | null;
  subIssues: readonly any[];
  blockedBy: readonly any[];
  blocking: readonly any[];
  validators: readonly PageValidator[];
}
export interface ClosingIssueReference { repositoryId: number; number: number }
export interface PullRequestClosingIssueSets {
  all: readonly ClosingIssueReference[];
  manual: readonly ClosingIssueReference[];
  automatic: readonly ClosingIssueReference[];
}

export const closingIssuesReferencesQuery = `query PullRequestClosingIssues($owner: String!, $repo: String!, $number: Int!, $cursor: String, $userLinkedOnly: Boolean, $excludeUserLinked: Boolean) {
  repository(owner: $owner, name: $repo) {
    databaseId
    pullRequest(number: $number) {
      closingIssuesReferences(first: 100, after: $cursor, userLinkedOnly: $userLinkedOnly, excludeUserLinked: $excludeUserLinked) {
        nodes { number repository { databaseId } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

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

  private absoluteUrl(path: string): string {
    const base = new URL(this.apiBase);
    const candidate = path.startsWith("http") ? new URL(path) : new URL(path, base);
    if (candidate.origin !== base.origin || candidate.username || candidate.password || candidate.hash) throw new Error("GitHub API请求来源无效");
    return candidate.href;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = this.absoluteUrl(path);
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
      const absolute = this.absoluteUrl(url);
      const response = await this.transport.call(globalThis, absolute, { headers: githubHeaders(this.token, this.policySha) });
      if (!response.ok) throw new GitHubRequestError(response.status, "GET", url, await response.text());
      const value = await response.json();
      const next = nextLink(response.headers);
      return next ? { items: select(value), next: this.absoluteUrl(next) } : { items: select(value) };
    });
  }

  private async readValidatedPage<T>(resource: IssueFactResource, path: string, select: (value: unknown) => readonly T[], allowNotFound = false): Promise<{ items: readonly T[]; validator: PageValidator }> {
    const absolute = this.absoluteUrl(path);
    const response = await this.transport.call(globalThis, absolute, { method: "GET", headers: githubHeaders(this.token, this.policySha) });
    if (response.status === 404 && allowNotFound) return { items: [], validator: { resource, url: absolute, etag: null, next: null, status: 404 } };
    if (!response.ok) throw new GitHubRequestError(response.status, "GET", path, (await response.text()).slice(0, 1000) || response.statusText);
    const value = await response.json();
    const next = nextLink(response.headers);
    return {
      items: select(value),
      validator: {
        resource,
        url: absolute,
        etag: response.headers.get("etag"),
        next: next ? this.absoluteUrl(next) : null,
        status: 200,
      },
    };
  }

  private async valueWithValidator<T>(resource: IssueFactResource, path: string, allowNotFound = false): Promise<ValidatedValue<T | null>> {
    const page = await this.readValidatedPage<T>(resource, path, value => [value as T], allowNotFound);
    return { value: page.validator.status === 404 ? null : page.items[0]!, validator: page.validator };
  }

  async paginateWithValidators<T>(resource: IssueFactResource, path: string, select: (value: unknown) => readonly T[] = value => value as readonly T[]): Promise<ValidatedCollection<T>> {
    const validators: PageValidator[] = [];
    const items = await collectAllPages(path, async url => {
      const page = await this.readValidatedPage(resource, url, select);
      validators.push(page.validator);
      return page.validator.next ? { items: page.items, next: page.validator.next } : { items: page.items };
    });
    return { items, validators: Object.freeze(validators) };
  }

  async revalidatePageValidators(validators: readonly PageValidator[]): Promise<{ state: "not-modified" } | { state: "modified" | "unverifiable"; resource: IssueFactResource; url: string }> {
    for (let index = 0; index < validators.length; index += 1) {
      const validator = validators[index]!;
      const url = this.absoluteUrl(validator.url);
      const following = validators[index + 1];
      const expectedNext = following?.resource === validator.resource ? this.absoluteUrl(following.url) : null;
      if (validator.next !== expectedNext || validator.status !== 200 || !validator.etag) return { state: "unverifiable", resource: validator.resource, url };
    }
    for (const validator of validators) {
      const headers = new Headers(githubHeaders(this.token, this.policySha));
      headers.set("If-None-Match", validator.etag!);
      const response = await this.transport.call(globalThis, validator.url, { method: "GET", headers });
      if (response.status === 304) {
        const responseNext = nextLink(response.headers);
        if (responseNext && this.absoluteUrl(responseNext) !== validator.next) return { state: "modified", resource: validator.resource, url: validator.url };
        continue;
      }
      if (response.ok) return { state: "modified", resource: validator.resource, url: validator.url };
      throw new GitHubRequestError(response.status, "GET", validator.url, (await response.text()).slice(0, 1000) || response.statusText);
    }
    return { state: "not-modified" };
  }

  async getIssueWithValidator(owner: string, repo: string, number: number): Promise<ValidatedValue<any>> {
    return await this.valueWithValidator<any>("issue", `/repos/${owner}/${repo}/issues/${number}`) as ValidatedValue<any>;
  }

  listIssueCommentsWithValidators(owner: string, repo: string, number: number) { return this.paginateWithValidators<any>("comments", `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`); }
  listIssueFieldValuesWithValidators(owner: string, repo: string, number: number) { return this.paginateWithValidators<any>("field-values", `/repos/${owner}/${repo}/issues/${number}/issue-field-values?per_page=100`); }
  async getIssueParentWithValidator(owner: string, repo: string, number: number): Promise<ValidatedValue<any | null>> { return this.valueWithValidator<any>("parent", `/repos/${owner}/${repo}/issues/${number}/parent`, true); }
  listSubIssuesWithValidators(owner: string, repo: string, number: number) { return this.paginateWithValidators<any>("sub-issues", `/repos/${owner}/${repo}/issues/${number}/sub_issues?per_page=100`); }
  listBlockedByWithValidators(owner: string, repo: string, number: number) { return this.paginateWithValidators<any>("blocked-by", `/repos/${owner}/${repo}/issues/${number}/dependencies/blocked_by?per_page=100`); }
  listBlockingWithValidators(owner: string, repo: string, number: number) { return this.paginateWithValidators<any>("blocking", `/repos/${owner}/${repo}/issues/${number}/dependencies/blocking?per_page=100`); }
  listOpenIssuesWithValidators(owner: string, repo: string) { return this.paginateWithValidators<any>("open-issues", `/repos/${owner}/${repo}/issues?state=open&per_page=100`); }

  private assertIssueBelongsToRepository(issue: any, owner: string, repo: string, number: number): void {
    let path: string;
    try { path = new URL(String(issue?.repository_url)).pathname; }
    catch { throw new Error("issue-repository-mismatch"); }
    const expected = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`.toLowerCase();
    if (path.toLowerCase() !== expected || issue?.number !== number || Object.hasOwn(issue ?? {}, "pull_request")) throw new Error("issue-repository-mismatch");
  }

  async readIssueFacts(owner: string, repo: string, number: number): Promise<GitHubIssueFacts> {
    const issue = await this.getIssueWithValidator(owner, repo, number);
    this.assertIssueBelongsToRepository(issue.value, owner, repo, number);
    const [comments, fieldValues, parent, subIssues, blockedBy, blocking] = await Promise.all([
      this.listIssueCommentsWithValidators(owner, repo, number),
      this.listIssueFieldValuesWithValidators(owner, repo, number),
      this.getIssueParentWithValidator(owner, repo, number),
      this.listSubIssuesWithValidators(owner, repo, number),
      this.listBlockedByWithValidators(owner, repo, number),
      this.listBlockingWithValidators(owner, repo, number),
    ]);
    return {
      issue: issue.value,
      comments: comments.items,
      fieldValues: fieldValues.items,
      parent: parent.value,
      subIssues: subIssues.items,
      blockedBy: blockedBy.items,
      blocking: blocking.items,
      validators: Object.freeze([issue.validator, ...comments.validators, ...fieldValues.validators, parent.validator, ...subIssues.validators, ...blockedBy.validators, ...blocking.validators]),
    };
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = await this.request<{ data?: T; errors?: Array<{ message?: string }> }>("POST", "/graphql", { query, variables });
    if (result.errors?.length || !result.data) throw new Error(`GitHub GraphQL请求失败: ${result.errors?.map((error) => error.message ?? "unknown").join("; ") || "missing-data"}`);
    return result.data;
  }

  private async listClosingIssueSet(owner: string, repo: string, number: number, expectedRepositoryId: number, mode: "all" | "manual" | "automatic"): Promise<readonly ClosingIssueReference[]> {
    const items: ClosingIssueReference[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const data: any = await this.graphql(closingIssuesReferencesQuery, {
        owner,
        repo,
        number,
        cursor,
        userLinkedOnly: mode === "manual" ? true : null,
        excludeUserLinked: mode === "automatic" ? true : null,
      });
      if (!data.repository || data.repository.databaseId !== expectedRepositoryId || !data.repository.pullRequest) throw new Error("issue-repository-mismatch");
      const connection = data.repository.pullRequest.closingIssuesReferences;
      if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new Error("GitHub GraphQL关闭议题响应无效");
      for (const node of connection.nodes) {
        if (!Number.isSafeInteger(node?.number) || node.number <= 0 || !Number.isSafeInteger(node?.repository?.databaseId) || node.repository.databaseId <= 0) throw new Error("GitHub GraphQL关闭议题节点无效");
        items.push({ repositoryId: node.repository.databaseId, number: node.number });
      }
      if (!connection.pageInfo.hasNextPage) break;
      const next = connection.pageInfo.endCursor;
      if (typeof next !== "string" || !next || seenCursors.has(next)) throw new Error("GitHub GraphQL关闭议题分页无效");
      seenCursors.add(next);
      cursor = next;
      if (page === 99) throw new Error("GitHub GraphQL关闭议题分页超过合同上限");
    }
    items.sort((left, right) => left.repositoryId - right.repositoryId || left.number - right.number);
    const keys = items.map((item) => `${item.repositoryId}:${item.number}`);
    if (new Set(keys).size !== keys.length) throw new Error("GitHub GraphQL关闭议题集合重复");
    return Object.freeze(items);
  }

  async listPullRequestClosingIssueSets(owner: string, repo: string, number: number, expectedRepositoryId: number): Promise<PullRequestClosingIssueSets> {
    const [all, manual, automatic] = await Promise.all([
      this.listClosingIssueSet(owner, repo, number, expectedRepositoryId, "all"),
      this.listClosingIssueSet(owner, repo, number, expectedRepositoryId, "manual"),
      this.listClosingIssueSet(owner, repo, number, expectedRepositoryId, "automatic"),
    ]);
    return { all, manual, automatic };
  }

  getRepository(owner: string, repo: string) { return this.request<any>("GET", `/repos/${owner}/${repo}`); }
  getRepositoryById(id: number) { return this.request<any>("GET", `/repositories/${id}`); }
  getPullRequest(owner: string, repo: string, number: number) { return this.request<any>("GET", `/repos/${owner}/${repo}/pulls/${number}`); }
  listPullRequests(owner: string, repo: string, head: string) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=100`); }
  listOpenPullRequests(owner: string, repo: string, base: string) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`); }
  listAllOpenPullRequests(owner: string, repo: string) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`); }
  getWorkflowRun(owner: string, repo: string, id: number) { return this.request<any>("GET", `/repos/${owner}/${repo}/actions/runs/${id}`); }
  createPullRequest(owner: string, repo: string, body: unknown) { return this.request<any>("POST", `/repos/${owner}/${repo}/pulls`, body); }
  updatePullRequest(owner: string, repo: string, number: number, body: unknown) { return this.request<any>("PATCH", `/repos/${owner}/${repo}/pulls/${number}`, body); }
  compare(owner: string, repo: string, base: string, head: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`); }
  getCommit(owner: string, repo: string, ref: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`); }
  listPullFiles(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`); }
  listPullCommits(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`); }
  listLabels(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/issues/${number}/labels?per_page=100`); }
  addLabels(owner: string, repo: string, number: number, labels: readonly string[]) { return this.request<any>("POST", `/repos/${owner}/${repo}/issues/${number}/labels`, { labels }); }
  removeLabel(owner: string, repo: string, number: number, label: string) { return this.request<void>("DELETE", `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`); }
  getLabel(owner: string, repo: string, name: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`); }
  createLabel(owner: string, repo: string, body: unknown) { return this.request<any>("POST", `/repos/${owner}/${repo}/labels`, body); }
  updateLabel(owner: string, repo: string, name: string, body: unknown) { return this.request<any>("PATCH", `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, body); }
  listRepositoryLabels(owner: string, repo: string) { return this.paginate<any>(`/repos/${owner}/${repo}/labels?per_page=100`); }
  listCheckRuns(owner: string, repo: string, ref: string) { return this.request<any>("GET", `/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`); }
  listAllCheckRuns(owner: string, repo: string, ref: string) { return this.paginate<any>(`/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`, value => (value as any).check_runs); }
  createCheckRun(owner: string, repo: string, body: unknown) { return this.request<any>("POST", `/repos/${owner}/${repo}/check-runs`, body); }
  updateCheckRun(owner: string, repo: string, id: number, body: unknown) { return this.request<any>("PATCH", `/repos/${owner}/${repo}/check-runs/${id}`, body); }
  getRequestedReviewers(owner: string, repo: string, number: number) { return this.request<any>("GET", `/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`); }
  listPullRequestReviews(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`); }
  listIssueEvents(owner: string, repo: string, number: number) { return this.paginate<any>(`/repos/${owner}/${repo}/issues/${number}/events?per_page=100`); }
  requestReviewers(owner: string, repo: string, number: number, reviewers: readonly string[]) { return this.request<any>("POST", `/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, { reviewers }); }
  requestTeamReviewers(owner: string, repo: string, number: number, teams: readonly string[]) { return this.request<any>("POST", `/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, { team_reviewers: teams }); }
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
  listInstallationRepositories() { return this.paginate<any>("/installation/repositories?per_page=100", value => (value as any).repositories); }
  listRepositoryTeams(owner: string, repo: string) { return this.paginate<any>(`/repos/${owner}/${repo}/teams?per_page=100`); }
  listRepositoryRulesets(owner: string, repo: string) { return this.paginate<any>(`/repos/${owner}/${repo}/rulesets?includes_parents=true&per_page=100`); }
  getTeamMembership(owner: string, teamSlug: string, username: string) { return this.request<any>("GET", `/orgs/${owner}/teams/${teamSlug}/memberships/${username}`); }
  deleteReleaseAsset(owner: string, repo: string, id: number) { return this.request<void>("DELETE", `/repos/${owner}/${repo}/releases/assets/${id}`); }
}
