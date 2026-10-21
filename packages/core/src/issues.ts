import { createHash } from 'node:crypto';

export const contributorBlockAnchor = '<!-- workflow:contributors -->';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const managedPrStart = '<!-- workflow:managed-pr:start -->';
const managedPrEnd = '<!-- workflow:managed-pr:end -->';
const legacyManagedPrStart = '<!-- workflow:auto-summary:start -->';
const legacyManagedPrEnd = '<!-- workflow:auto-summary:end -->';
const issueLinksStartPrefix = '<!-- workflow:issue-links:start';
export const issueLinksEnd = '<!-- workflow:issue-links:end -->';
export const stewardBotUserId = 301115370;

export function isStewardOwnedPullRequest(pull: any, repositoryId: number): boolean {
  return Number(pull?.user?.id) === stewardBotUserId
    && Number(pull?.head?.repo?.id) === repositoryId
    && Number(pull?.base?.repo?.id) === repositoryId;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('规范化对象包含非有限数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`;
}

function integer(value: unknown, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name}无效`);
  return value as number;
}

export interface DesiredIssueReference { repositoryId: number; number: number }

export interface IssueLinkConvergence {
  converged: boolean;
  expectedAutomatic: DesiredIssueReference[];
}

function stableIssueReferenceSet(values: readonly DesiredIssueReference[]): string[] {
  return values.map(value => `${value.repositoryId}:${value.number}`).sort();
}

export function verifyIssueLinkConvergence(
  desired: readonly DesiredIssueReference[],
  sets: { all: readonly DesiredIssueReference[]; manual: readonly DesiredIssueReference[]; automatic: readonly DesiredIssueReference[] },
  repositoryId: number,
): IssueLinkConvergence {
  const desiredKeys = new Set(stableIssueReferenceSet(desired));
  const manualKeys = new Set(stableIssueReferenceSet(sets.manual));
  const expectedAutomatic = desired.filter(item => !manualKeys.has(`${item.repositoryId}:${item.number}`));
  const expectedKeys = stableIssueReferenceSet(expectedAutomatic);
  const automaticKeys = stableIssueReferenceSet(sets.automatic);
  const allKeys = new Set(stableIssueReferenceSet(sets.all));
  const converged = desired.every(item => allKeys.has(`${item.repositoryId}:${item.number}`))
    && sets.automatic.every(item => item.repositoryId === repositoryId)
    && JSON.stringify(automaticKeys) === JSON.stringify(expectedKeys)
    && desiredKeys.size === desired.length;
  return { converged, expectedAutomatic };
}

export function desiredIssueSetDigest(issues: readonly DesiredIssueReference[]): string {
  const normalized = issues.map((issue) => ({ repositoryId: integer(issue.repositoryId, 'repositoryId'), number: integer(issue.number, 'issueNumber') }))
    .sort((left, right) => left.repositoryId - right.repositoryId || left.number - right.number);
  const keys = normalized.map((issue) => `${issue.repositoryId}:${issue.number}`);
  if (new Set(keys).size !== keys.length) throw new Error('目标议题集合包含重复编号');
  return sha256(stableJson(normalized));
}

function requireSha(value: unknown, name: string): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error(`${name}无效`);
  return value;
}

function requireDigest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error(`${name}无效`);
  return value;
}

export interface IssueLinksMetadata {
  repositoryId: number;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  generation: number;
  analysisInputDigest: string;
}

export interface ParsedIssueLinksMetadata extends IssueLinksMetadata {
  desiredSetDigest: string;
  issueNumbers: number[];
}

export interface IssueLinksRegion {
  start: number;
  end: number;
  block: string;
  metadata: ParsedIssueLinksMetadata;
}

interface IssueLinksBlockBounds {
  start: number;
  end: number;
  block: string;
}

function occurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function parseIssueLinksBlock(block: string): ParsedIssueLinksMetadata {
  if (block.includes('\r')) throw new Error('议题子块只能使用LF换行');
  const lines = block.split('\n');
  const marker = lines[0]?.match(/^<!-- workflow:issue-links:start repo=(\d+) pr=(\d+) base=([0-9a-f]{40}) head=([0-9a-f]{40}) generation=(\d+) input=sha256:([0-9a-f]{64}) set=sha256:([0-9a-f]{64}) -->$/u);
  if (!marker || lines.at(-1) !== issueLinksEnd) throw new Error('议题子块标记或字段无效');
  const repositoryId = integer(Number(marker[1]), 'repo');
  const pullRequestNumber = integer(Number(marker[2]), 'pr');
  const baseSha = requireSha(marker[3], 'base');
  const headSha = requireSha(marker[4], 'head');
  const generation = integer(Number(marker[5]), 'generation', 0);
  const analysisDigest = requireDigest(marker[6], 'input');
  const setDigest = requireDigest(marker[7], 'set');
  const content = lines.slice(1, -1);
  let issueNumbers: number[] = [];
  if (content.length > 0) {
    if (content[0] !== '## 解决的议题' || content[1] !== '' || content.length < 3) throw new Error('议题子块正文无效');
    issueNumbers = content.slice(2).map((line, index) => {
      const match = line.match(/^Resolves #(\d+)$/u);
      if (!match) throw new Error(`议题子块第${index + 1}行关闭关键字无效`);
      return integer(Number(match[1]), 'issueNumber');
    });
    const sorted = [...issueNumbers].sort((left, right) => left - right);
    if (issueNumbers.some((number, index) => number !== sorted[index]) || new Set(issueNumbers).size !== issueNumbers.length || issueNumbers.length > 10) throw new Error('议题子块集合无效');
  }
  const expectedSetDigest = desiredIssueSetDigest(issueNumbers.map((number) => ({ repositoryId, number })));
  if (expectedSetDigest !== setDigest) throw new Error('议题子块集合摘要不一致');
  return { repositoryId, pullRequestNumber, baseSha, headSha, generation, analysisInputDigest: analysisDigest, desiredSetDigest: setDigest, issueNumbers };
}

export function renderIssueLinksBlock(metadata: IssueLinksMetadata, issues: readonly DesiredIssueReference[]): string {
  const repositoryId = integer(metadata.repositoryId, 'repositoryId');
  const normalized = issues.map((issue) => {
    if (issue.repositoryId !== repositoryId) throw new Error('issue-repository-mismatch');
    return { repositoryId, number: integer(issue.number, 'issueNumber') };
  }).sort((left, right) => left.number - right.number);
  if (normalized.length > 10) throw new Error('正式关联总数超过10个');
  const setDigest = desiredIssueSetDigest(normalized);
  const start = `<!-- workflow:issue-links:start repo=${repositoryId} pr=${integer(metadata.pullRequestNumber, 'pullRequestNumber')} base=${requireSha(metadata.baseSha, 'baseSha')} head=${requireSha(metadata.headSha, 'headSha')} generation=${integer(metadata.generation, 'generation', 0)} input=sha256:${requireDigest(metadata.analysisInputDigest, 'analysisInputDigest')} set=sha256:${setDigest} -->`;
  const visible = normalized.length ? `\n## 解决的议题\n\n${normalized.map((issue) => `Resolves #${issue.number}`).join('\n')}` : '';
  return `${start}${visible}\n${issueLinksEnd}`;
}

function locateIssueLinksBlock(body: string): IssueLinksBlockBounds | null {
  const startCount = occurrences(body, issueLinksStartPrefix);
  const endCount = occurrences(body, issueLinksEnd);
  if (startCount === 0 && endCount === 0) return null;
  if (startCount !== 1 || endCount !== 1) throw new Error('议题子块标记缺失或重复');
  const start = body.indexOf(issueLinksStartPrefix);
  const endMarker = body.indexOf(issueLinksEnd, start + issueLinksStartPrefix.length);
  const end = endMarker < 0 ? -1 : endMarker + issueLinksEnd.length;
  if (start < 0 || endMarker < 0 || end <= start || (start > 0 && body[start - 1] !== '\n') || (end < body.length && body[end] !== '\n')) throw new Error('议题子块边界无效');
  const block = body.slice(start, end);
  return { start, end, block };
}

export function extractIssueLinksBlock(body: string): IssueLinksRegion | null {
  const region = locateIssueLinksBlock(body);
  return region ? { ...region, metadata: parseIssueLinksBlock(region.block) } : null;
}

function managedOuterRegion(body: string): { start: number; contentStart: number; end: number } {
  const current = occurrences(body, managedPrStart) === 1 && occurrences(body, managedPrEnd) === 1;
  const legacy = occurrences(body, legacyManagedPrStart) === 1 && occurrences(body, legacyManagedPrEnd) === 1;
  const hasCurrent = body.includes(managedPrStart) || body.includes(managedPrEnd);
  const hasLegacy = body.includes(legacyManagedPrStart) || body.includes(legacyManagedPrEnd);
  if ((hasCurrent && hasLegacy) || (hasCurrent && !current) || (hasLegacy && !legacy) || (!hasCurrent && !hasLegacy)) throw new Error('议题子块缺少唯一外层受管标记');
  const startMarker = current ? managedPrStart : legacyManagedPrStart;
  const endMarker = current ? managedPrEnd : legacyManagedPrEnd;
  const start = body.indexOf(startMarker);
  const end = body.indexOf(endMarker, start);
  if (end <= start) throw new Error('议题子块外层受管标记交叉');
  return { start, contentStart: start + startMarker.length, end };
}

export function upsertIssueLinksBlock(body: string, block: string): string {
  const outer = managedOuterRegion(body);
  const replacement = extractIssueLinksBlock(block);
  if (!replacement || replacement.start !== 0 || replacement.end !== block.length) throw new Error('替换议题子块无效');
  const current = extractIssueLinksBlock(body);
  if (current) {
    if (current.start <= outer.start || current.end > outer.end) throw new Error('议题子块不在唯一外层受管区域内');
    return `${body.slice(0, current.start)}${block}${body.slice(current.end)}`;
  }
  const searchStart = outer.contentStart;
  const anchors = ['\n## 发布与迁移\n', `\n${contributorBlockAnchor}\n`, '\n## 贡献者\n', '\n<!-- workflow:source-actor:']
    .map((anchor) => body.indexOf(anchor, searchStart))
    .filter((index) => index >= searchStart && index < outer.end)
    .map((index) => index + 1);
  const insertion = anchors.length ? Math.min(...anchors) : outer.end;
  return `${body.slice(0, insertion)}${block}\n\n${body.slice(insertion)}`;
}

export function removeIssueLinksBlock(body: string): string {
  const outer = managedOuterRegion(body);
  const current = locateIssueLinksBlock(body);
  if (!current) return body;
  if (current.start <= outer.start || current.end > outer.end) throw new Error('议题子块不在唯一外层受管区域内');
  const end = body.slice(current.end, current.end + 2) === '\n\n' ? current.end + 2 : current.end;
  return `${body.slice(0, current.start)}${body.slice(end)}`;
}

export function managedBodyOutsideIssueLinksDigest(body: string): string {
  const region = extractIssueLinksBlock(body);
  if (region) {
    const outer = managedOuterRegion(body);
    if (region.start <= outer.start || region.end > outer.end) throw new Error('议题子块不在唯一外层受管区域内');
  }
  return sha256(region ? removeIssueLinksBlock(body) : body);
}
