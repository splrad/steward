import { sha256HexUtf8 } from '../../manifest/src/digest.js';
import { realContributorLoginsFromBody, uniqueHumanLogins } from './identity.js';

export interface PullRequestFingerprintInput {
  pull: {
    title?: unknown;
    body?: unknown;
    user?: { login?: unknown } | null;
    head?: { sha?: unknown } | null;
    base?: { ref?: unknown; sha?: unknown } | null;
  };
  commits?: readonly {
    sha?: unknown;
    author?: { login?: unknown } | null;
  }[];
  files?: readonly {
    filename?: unknown;
    status?: unknown;
    sha?: unknown;
    additions?: unknown;
    deletions?: unknown;
  }[];
  botLogins?: readonly unknown[];
}

export interface PullRequestFingerprint {
  head_sha: string;
  base_ref: string;
  base_sha: string;
  commits: string[];
  contributors: string[];
  files_digest: string;
  classification_digest: string;
  value: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function text(value: unknown): string {
  return String(value ?? '');
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function hashJson(value: unknown): Promise<string> {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Value is not JSON serializable');
  return sha256HexUtf8(json);
}

export function normalizeRepositoryPath(value: unknown): string {
  return text(value).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function escapeRepositoryPatternText(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function repositoryPathPatternMatches(file: unknown, pattern: unknown): boolean {
  const value = normalizeRepositoryPath(pattern);
  let regex = '^';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '*') {
      if (value[index + 1] === '*') {
        regex += '.*';
        index += 1;
      } else {
        regex += '[^/]*';
      }
    } else {
      regex += escapeRepositoryPatternText(character ?? '');
    }
  }
  return new RegExp(`${regex}$`).test(normalizeRepositoryPath(file));
}

export function classificationInputBody(body: unknown): string {
  return text(body)
    .replace(/\n*<!-- workflow:pr-classification:start[\s\S]*?workflow:pr-classification:end -->/gi, '')
    .trimEnd();
}

export async function fingerprintForPull(input: PullRequestFingerprintInput): Promise<PullRequestFingerprint> {
  const commits = input.commits ?? [];
  const files = input.files ?? [];
  const botLogins = input.botLogins ?? [];
  const commitShas = commits.map((commit) => text(commit.sha)).filter(Boolean).sort(compareText);
  const fileParts = files.map((file) => [
    normalizeRepositoryPath(file.filename),
    text(file.status),
    text(file.sha),
    count(file.additions),
    count(file.deletions),
  ] as const).sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
  const contributors = uniqueHumanLogins([
    ...realContributorLoginsFromBody({
      body: input.pull.body,
      prAuthor: input.pull.user?.login,
      botLogins,
    }),
    ...commits.map((commit) => commit.author?.login),
  ], { botLogins })
    .map((login) => login.toLowerCase())
    .sort(compareText);
  const [bodyDigest, filesDigest] = await Promise.all([
    hashJson(classificationInputBody(input.pull.body)),
    hashJson(fileParts),
  ]);
  const classificationInputs = {
    title: text(input.pull.title),
    body_digest: bodyDigest,
  };
  const classificationDigest = await hashJson(classificationInputs);
  const source = {
    head_sha: text(input.pull.head?.sha),
    base_ref: text(input.pull.base?.ref),
    base_sha: text(input.pull.base?.sha),
    commits: commitShas,
    contributors,
    files_digest: filesDigest,
    classification_digest: classificationDigest,
  };
  return { ...source, value: await hashJson(source) };
}
