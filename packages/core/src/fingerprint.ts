const encoder = new TextEncoder();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface PullRequestFingerprintInput {
  repositoryId: number;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
  commits: readonly string[];
  files: readonly { path: string; status: string; additions: number; deletions: number }[];
  title: string;
  body: string;
  contributors: readonly { id: number; login: string }[];
}

export async function computePullRequestFingerprint(input: PullRequestFingerprintInput): Promise<string> {
  const normalized = {
    ...input,
    commits: [...input.commits].sort(),
    files: [...input.files].sort((a, b) => a.path.localeCompare(b.path)),
    contributors: [...input.contributors].sort((a, b) => a.id - b.id || a.login.localeCompare(b.login)),
  };
  return sha256Hex(JSON.stringify(canonicalize(normalized)));
}
