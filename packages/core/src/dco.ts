export type DcoIssueReason = 'missing' | 'invalid-format' | 'email-mismatch';

export interface DcoIdentity {
  login?: string | undefined;
  type?: string | undefined;
  name?: string | undefined;
  email?: string | undefined;
}

export interface DcoCommitInput {
  sha: string;
  message: string;
  author?: DcoIdentity | null;
  committer?: DcoIdentity | null;
}

export interface DcoSignOff {
  raw: string;
  valid: boolean;
  name?: string;
  email?: string;
}

export interface DcoIssue {
  sha: string;
  subject: string;
  reason: DcoIssueReason;
  authorName: string;
  authorEmail: string;
  signedEmails: string[];
  signedEmailsTruncated: number;
}

export interface DcoEvaluation {
  total: number;
  passed: number;
  skipped: number;
  issues: DcoIssue[];
}

const maxReportedSignOffEmails = 20;

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function email(value: unknown): string {
  return text(value).toLowerCase();
}

function botKey(value: unknown): string {
  return text(value).toLowerCase().replace(/\[bot\]$/, '');
}

function commitIdentity(commit: DcoCommitInput): DcoIdentity {
  return {
    login: commit.author?.login || commit.committer?.login || '',
    type: commit.author?.type || commit.committer?.type || '',
    name: commit.author?.name || commit.committer?.name || '',
    email: commit.author?.email || commit.committer?.email || '',
  };
}

function isBotIdentity(identity: DcoIdentity, botLogins: readonly unknown[]): boolean {
  const values = [identity.login, identity.name, identity.email].map((value) => text(value).toLowerCase());
  const configured = new Set(botLogins.map(botKey).filter(Boolean));
  return text(identity.type).toLowerCase() === 'bot'
    || values.some((value) => value.endsWith('[bot]') || value.includes('[bot]@'))
    || values.some((value) => value === 'dependabot' || value === 'github-actions')
    || configured.has(botKey(identity.login));
}

export function parseDcoSignOffs(message: unknown): DcoSignOff[] {
  return String(message ?? '').split(/\r?\n/)
    .filter((line) => /^\s*Signed-off-by\s*:/i.test(line))
    .map((line) => {
      const raw = line.trim();
      const match = line.match(/^\s*Signed-off-by\s*:\s*(.+?)\s*<([^<>@\s]+@[^<>\s]+)>\s*$/i);
      if (!match) return { raw, valid: false };
      return { raw, valid: true, name: text(match[1]), email: email(match[2]) };
    });
}

function subject(message: string): string {
  return message.split(/\r?\n/)[0]?.trim() || '(empty commit message)';
}

export function evaluateDcoAdvisory(
  commits: readonly DcoCommitInput[],
  options: { botLogins?: readonly unknown[] } = {},
): DcoEvaluation {
  const issues: DcoIssue[] = [];
  let passed = 0;
  let skipped = 0;
  for (const commit of commits) {
    const identity = commitIdentity(commit);
    if (isBotIdentity(identity, options.botLogins ?? [])) {
      skipped += 1;
      continue;
    }
    const signOffs = parseDcoSignOffs(commit.message);
    const valid = signOffs.filter((item) => item.valid);
    const authorEmail = email(identity.email);
    const signedEmails = [...new Set(valid.map((item) => item.email ?? '').filter(Boolean))];
    const base = {
      sha: commit.sha,
      subject: subject(commit.message),
      authorName: text(identity.name),
      authorEmail,
      signedEmails: signedEmails.slice(0, maxReportedSignOffEmails),
      signedEmailsTruncated: Math.max(0, signedEmails.length - maxReportedSignOffEmails),
    };
    if (!signOffs.length) issues.push({ ...base, reason: 'missing' });
    else if (!valid.length) issues.push({ ...base, reason: 'invalid-format' });
    else if (!authorEmail || !valid.some((item) => item.email === authorEmail)) {
      issues.push({ ...base, reason: 'email-mismatch' });
    } else {
      passed += 1;
    }
  }
  return { total: commits.length, passed, skipped, issues };
}
