import { createHash } from 'node:crypto';

export type IssueState = 'open' | 'closed';
export type UnfetchedReferenceType = 'image' | 'file' | 'document';

export interface UnfetchedReference {
  source: string;
  line: number;
  type: UnfetchedReferenceType;
  urlDigest: string;
}

export interface IssueRelationSnapshot {
  repositoryId: number;
  number: number;
  title: string;
  state: IssueState;
  updatedAt: string;
}

export interface IssueCommentSnapshot {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueFieldValueSnapshot {
  name: string;
  type: string;
  value: JsonValue;
}

export interface IssueMilestoneSnapshot {
  number: number;
  title: string;
  state: IssueState;
  dueOn: string | null;
}

export interface IssueSnapshotInput {
  repository: { id: number; fullName: string };
  issue: {
    number: number;
    title: string;
    body: string;
    state: IssueState;
    labels: string[];
    milestone: IssueMilestoneSnapshot | null;
    stateReason: string | null;
    issueType: string | null;
    fieldValues: IssueFieldValueSnapshot[];
    createdAt: string;
    updatedAt: string;
    commentsCount: number;
  };
  comments: IssueCommentSnapshot[];
  parent: IssueRelationSnapshot | null;
  subIssues: IssueRelationSnapshot[];
  blockedBy: IssueRelationSnapshot[];
  blocking: IssueRelationSnapshot[];
}

export interface IssueSnapshot extends IssueSnapshotInput {
  schemaVersion: 1;
  unfetchedReferences: UnfetchedReference[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type UnknownRecord = Record<string, unknown>;

const maximumSnapshotBytes = 256 * 1024;
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const managedPrStart = '<!-- workflow:managed-pr:start -->';
const managedPrEnd = '<!-- workflow:managed-pr:end -->';
const legacyManagedPrStart = '<!-- workflow:auto-summary:start -->';
const legacyManagedPrEnd = '<!-- workflow:auto-summary:end -->';
const issueLinksStartPrefix = '<!-- workflow:issue-links:start';
export const issueLinksEnd = '<!-- workflow:issue-links:end -->';
export const stewardBotUserId = 301115370;

export function isIssueCapableRepository(repository: any, managed: boolean): boolean {
  return managed && repository?.has_issues === true && repository?.archived !== true && repository?.disabled !== true;
}

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

function asRecord(value: unknown, name: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name}必须是对象`);
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(`${name}包含额外字段`);
  if (allowed.some((key) => !Object.hasOwn(value, key))) throw new Error(`${name}字段缺失`);
}

function integer(value: unknown, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name}无效`);
  return value as number;
}

function text(value: unknown, name: string, minimum = 0, maximum = 1_000_000): string {
  if (typeof value !== 'string') throw new TypeError(`${name}必须是字符串`);
  const size = [...value].length;
  if (size < minimum || size > maximum || value.includes('\0')) throw new Error(`${name}长度或格式无效`);
  return value;
}

function singleLine(value: unknown, name: string, minimum = 1, maximum = 500): string {
  const result = text(value, name, 0, 1_000_000).trim();
  const size = [...result].length;
  if (size < minimum || size > maximum || /\r|\n/u.test(result)) throw new Error(`${name}长度或格式无效`);
  return result;
}

function timestamp(value: unknown, name: string): string {
  const result = singleLine(value, name, 20, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) || Number.isNaN(Date.parse(result))) throw new Error(`${name}时间无效`);
  return result;
}

function state(value: unknown, name: string): IssueState {
  if (value !== 'open' && value !== 'closed') throw new Error(`${name}状态无效`);
  return value;
}

function jsonValue(value: unknown, name: string, depth = 0): JsonValue {
  if (depth > 8) throw new Error(`${name}嵌套过深`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${name}[${index}]`, depth + 1));
  const object = asRecord(value, name);
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, jsonValue(object[key], `${name}.${key}`, depth + 1)]));
}

function relation(value: unknown, name: string): IssueRelationSnapshot {
  const object = asRecord(value, name);
  exactKeys(object, ['repositoryId', 'number', 'title', 'state', 'updatedAt'], name);
  return {
    repositoryId: integer(object.repositoryId, `${name}.repositoryId`),
    number: integer(object.number, `${name}.number`),
    title: singleLine(object.title, `${name}.title`, 1, 512),
    state: state(object.state, `${name}.state`),
    updatedAt: timestamp(object.updatedAt, `${name}.updatedAt`),
  };
}

function relations(value: unknown, name: string): IssueRelationSnapshot[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error(`${name}无效`);
  const result = value.map((item, index) => relation(item, `${name}[${index}]`));
  const keys = result.map((item) => `${item.repositoryId}:${item.number}`);
  if (new Set(keys).size !== keys.length) throw new Error(`${name}包含重复议题`);
  return result.sort((left, right) => left.repositoryId - right.repositoryId || left.number - right.number);
}

function referenceType(url: URL, explicitImage: boolean): UnfetchedReferenceType {
  if (explicitImage) return 'image';
  const extension = url.pathname.toLowerCase().match(/\.([a-z0-9]{1,10})$/u)?.[1];
  if (extension && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'avif'].includes(extension)) return 'image';
  if (url.hostname.toLowerCase() === 'github.com' && url.pathname.includes('/user-attachments/')) return 'file';
  if (extension && ['zip', '7z', 'rar', 'gz', 'tgz', 'tar', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'dwg', 'dxf', 'csv', 'log', 'bin'].includes(extension)) return 'file';
  return 'document';
}

function normalizeUrl(candidate: string): URL | null {
  let cleaned = candidate.trim();
  if (cleaned.startsWith('<')) cleaned = cleaned.slice(1);
  if (cleaned.endsWith('>')) cleaned = cleaned.slice(0, -1);
  const trailing = new Set([')', ',', '.', ';', '!', '?', ']', '}']);
  let end = cleaned.length;
  while (end > 0 && trailing.has(cleaned[end - 1]!)) end--;
  cleaned = cleaned.slice(0, end);
  try {
    const url = new URL(cleaned);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

function markdownDestinations(line: string): readonly { value: string; image: boolean }[] {
  const values: { value: string; image: boolean }[] = [];
  let labelStart = -1;
  for (let cursor = 0; cursor < line.length; cursor++) {
    if (line[cursor] === '[') { labelStart = cursor; continue; }
    if (line[cursor] !== ']' || line[cursor + 1] !== '(') continue;
    let start = cursor + 2;
    while (start < line.length && (line[start] === ' ' || line[start] === '\t')) start++;
    const angle = line[start] === '<';
    if (angle) start++;
    const lower = line.slice(start, start + 8).toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) {
      let end = start;
      while (end < line.length) {
        const character = line[end]!;
        if ((angle && character === '>') || (!angle && (character === ')' || character === ' ' || character === '\t'))) break;
        end++;
      }
      values.push({ value: line.slice(start, end), image: labelStart > 0 && line[labelStart - 1] === '!' });
    }
    labelStart = -1;
  }
  return values;
}

function htmlAttributeUrls(line: string, tagName: 'img' | 'a', attribute: 'src' | 'href'): readonly string[] {
  const values: string[] = [];
  const lower = line.toLowerCase();
  for (let cursor = 0; cursor < line.length;) {
    const tagStart = lower.indexOf(`<${tagName}`, cursor);
    if (tagStart < 0) break;
    const tagEnd = line.indexOf('>', tagStart + tagName.length + 1);
    if (tagEnd < 0) break;
    const tag = line.slice(tagStart, tagEnd + 1);
    const tagLower = tag.toLowerCase();
    for (let attributeCursor = 0; attributeCursor < tag.length;) {
      const nameStart = tagLower.indexOf(attribute, attributeCursor);
      if (nameStart < 0) break;
      const before = nameStart === 0 ? ' ' : tagLower[nameStart - 1]!;
      const afterName = nameStart + attribute.length;
      if (/[A-Za-z0-9_-]/u.test(before) || /[A-Za-z0-9_-]/u.test(tagLower[afterName] ?? '')) { attributeCursor = afterName; continue; }
      let equals = afterName;
      while (equals < tag.length && (tag[equals] === ' ' || tag[equals] === '\t')) equals++;
      if (tag[equals] !== '=') { attributeCursor = afterName; continue; }
      let valueStart = equals + 1;
      while (valueStart < tag.length && (tag[valueStart] === ' ' || tag[valueStart] === '\t')) valueStart++;
      const quote = tag[valueStart];
      if (quote !== '"' && quote !== "'") { attributeCursor = valueStart + 1; continue; }
      const valueEnd = tag.indexOf(quote, valueStart + 1);
      if (valueEnd < 0) break;
      values.push(tag.slice(valueStart + 1, valueEnd));
      attributeCursor = valueEnd + 1;
    }
    cursor = tagEnd + 1;
  }
  return values;
}

function bareHttpUrls(line: string): readonly string[] {
  const values: string[] = [];
  const lower = line.toLowerCase();
  for (let cursor = 0; cursor < line.length;) {
    const start = lower.indexOf('http', cursor);
    if (start < 0) break;
    if (!lower.startsWith('http://', start) && !lower.startsWith('https://', start)) { cursor = start + 4; continue; }
    let end = start;
    while (end < line.length && ![' ', '\t', '<', '>', '"', "'"].includes(line[end]!)) end++;
    values.push(line.slice(start, end));
    cursor = Math.max(end, start + 1);
  }
  return values;
}

function extractReferences(body: string, source: string): UnfetchedReference[] {
  const references = new Map<string, UnfetchedReference>();
  const lines = body.split(/\r?\n/u);
  const add = (candidate: string, line: number, explicitImage: boolean) => {
    const url = normalizeUrl(candidate);
    if (!url) return;
    const urlDigest = sha256(url.href);
    const key = `${source}:${line}:${urlDigest}`;
    const value = { source, line, type: referenceType(url, explicitImage), urlDigest };
    const existing = references.get(key);
    if (!existing || (explicitImage && existing.type !== 'image')) references.set(key, value);
  };
  lines.forEach((lineText, index) => {
    for (const destination of markdownDestinations(lineText)) add(destination.value, index + 1, destination.image);
    for (const value of htmlAttributeUrls(lineText, 'img', 'src')) add(value, index + 1, true);
    for (const value of htmlAttributeUrls(lineText, 'a', 'href')) add(value, index + 1, false);
    for (const value of bareHttpUrls(lineText)) add(value, index + 1, false);
  });
  return [...references.values()].sort((left, right) => left.source.localeCompare(right.source) || left.line - right.line || left.urlDigest.localeCompare(right.urlDigest));
}

export function normalizeIssueSnapshot(value: unknown): IssueSnapshot {
  const root = asRecord(value, '议题快照输入');
  exactKeys(root, ['repository', 'issue', 'comments', 'parent', 'subIssues', 'blockedBy', 'blocking'], '议题快照输入');
  const repository = asRecord(root.repository, 'repository');
  exactKeys(repository, ['id', 'fullName'], 'repository');
  const repositoryId = integer(repository.id, 'repository.id');
  const fullName = singleLine(repository.fullName, 'repository.fullName', 3, 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName)) throw new Error('repository.fullName无效');

  const issue = asRecord(root.issue, 'issue');
  exactKeys(issue, ['number', 'title', 'body', 'state', 'labels', 'milestone', 'stateReason', 'issueType', 'fieldValues', 'createdAt', 'updatedAt', 'commentsCount'], 'issue');
  if (!Array.isArray(issue.labels) || issue.labels.length > 100) throw new Error('issue.labels无效');
  const labels = issue.labels.map((item, index) => singleLine(item, `issue.labels[${index}]`, 1, 100)).sort();
  if (new Set(labels).size !== labels.length) throw new Error('issue.labels包含重复值');
  let milestone: IssueMilestoneSnapshot | null = null;
  if (issue.milestone !== null) {
    const item = asRecord(issue.milestone, 'issue.milestone');
    exactKeys(item, ['number', 'title', 'state', 'dueOn'], 'issue.milestone');
    milestone = {
      number: integer(item.number, 'issue.milestone.number'),
      title: singleLine(item.title, 'issue.milestone.title', 1, 512),
      state: state(item.state, 'issue.milestone.state'),
      dueOn: item.dueOn === null ? null : timestamp(item.dueOn, 'issue.milestone.dueOn'),
    };
  }
  if (!Array.isArray(issue.fieldValues) || issue.fieldValues.length > 200) throw new Error('issue.fieldValues无效');
  const fieldValues = issue.fieldValues.map((value, index): IssueFieldValueSnapshot => {
    const item = asRecord(value, `issue.fieldValues[${index}]`);
    exactKeys(item, ['name', 'type', 'value'], `issue.fieldValues[${index}]`);
    return { name: singleLine(item.name, `issue.fieldValues[${index}].name`, 1, 200), type: singleLine(item.type, `issue.fieldValues[${index}].type`, 1, 100), value: jsonValue(item.value, `issue.fieldValues[${index}].value`) };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.type.localeCompare(right.type) || stableJson(left.value).localeCompare(stableJson(right.value)));

  if (!Array.isArray(root.comments) || root.comments.length > 10_000) throw new Error('comments无效');
  const comments = root.comments.map((value, index): IssueCommentSnapshot => {
    const item = asRecord(value, `comments[${index}]`);
    exactKeys(item, ['id', 'author', 'body', 'createdAt', 'updatedAt'], `comments[${index}]`);
    return {
      id: integer(item.id, `comments[${index}].id`),
      author: singleLine(item.author, `comments[${index}].author`, 1, 200),
      body: text(item.body, `comments[${index}].body`),
      createdAt: timestamp(item.createdAt, `comments[${index}].createdAt`),
      updatedAt: timestamp(item.updatedAt, `comments[${index}].updatedAt`),
    };
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id - right.id);
  if (new Set(comments.map((item) => item.id)).size !== comments.length) throw new Error('comments包含重复编号');
  const commentsCount = integer(issue.commentsCount, 'issue.commentsCount', 0);
  if (commentsCount !== comments.length) throw new Error('议题评论数量与完整评论集合不一致');

  const normalizedIssue = {
    number: integer(issue.number, 'issue.number'),
    title: singleLine(issue.title, 'issue.title', 1, 512),
    body: text(issue.body, 'issue.body'),
    state: state(issue.state, 'issue.state'),
    labels,
    milestone,
    stateReason: issue.stateReason === null ? null : singleLine(issue.stateReason, 'issue.stateReason', 1, 100),
    issueType: issue.issueType === null ? null : singleLine(issue.issueType, 'issue.issueType', 1, 200),
    fieldValues,
    createdAt: timestamp(issue.createdAt, 'issue.createdAt'),
    updatedAt: timestamp(issue.updatedAt, 'issue.updatedAt'),
    commentsCount,
  };
  const unfetchedReferences = [
    ...extractReferences(normalizedIssue.body, 'issue.body'),
    ...comments.flatMap((comment) => extractReferences(comment.body, `comment:${comment.id}.body`)),
  ].sort((left, right) => left.source.localeCompare(right.source) || left.line - right.line || left.urlDigest.localeCompare(right.urlDigest));
  const snapshot: IssueSnapshot = {
    schemaVersion: 1,
    repository: { id: repositoryId, fullName },
    issue: normalizedIssue,
    comments,
    parent: root.parent === null ? null : relation(root.parent, 'parent'),
    subIssues: relations(root.subIssues, 'subIssues'),
    blockedBy: relations(root.blockedBy, 'blockedBy'),
    blocking: relations(root.blocking, 'blocking'),
    unfetchedReferences,
  };
  issueSnapshotContentDigest(snapshot);
  return snapshot;
}

export function issueSnapshotContentDigest(snapshot: IssueSnapshot): string {
  const serialized = stableJson(snapshot as unknown as JsonValue);
  if (Buffer.byteLength(serialized, 'utf8') > maximumSnapshotBytes) throw new Error('议题快照超过256 KiB');
  return sha256(serialized);
}

function uniqueSortedIssueNumbers(repositoryId: number, numbers: readonly number[]): number[] {
  integer(repositoryId, 'repositoryId');
  const normalized = numbers.map((number) => integer(number, 'issueNumber')).sort((left, right) => left - right);
  if (new Set(normalized).size !== normalized.length) throw new Error('议题集合包含重复编号');
  return normalized;
}

export function openIssueSetDigest(repositoryId: number, issueNumbers: readonly number[]): string {
  return sha256(stableJson({ repositoryId, issueNumbers: uniqueSortedIssueNumbers(repositoryId, issueNumbers) }));
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

export interface AnalysisInput {
  repositoryId: number;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  generation: number;
  policySha: string;
  fullDiffDigest: string;
  candidateDigests: Array<{ repositoryId: number; number: number; contentDigest: string }>;
  openSetDigest: string;
  unmanagedBodyDigest: string;
}

function requireSha(value: unknown, name: string): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error(`${name}无效`);
  return value;
}

function requireDigest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error(`${name}无效`);
  return value;
}

export function analysisInputDigest(input: AnalysisInput): string {
  const repositoryId = integer(input.repositoryId, 'repositoryId');
  const candidates = input.candidateDigests.map((candidate) => {
    if (integer(candidate.repositoryId, 'candidate.repositoryId') !== repositoryId) throw new Error('issue-repository-mismatch');
    return { repositoryId, number: integer(candidate.number, 'candidate.number'), contentDigest: requireDigest(candidate.contentDigest, 'candidate.contentDigest') };
  }).sort((left, right) => left.number - right.number);
  if (new Set(candidates.map((candidate) => candidate.number)).size !== candidates.length) throw new Error('候选议题包含重复编号');
  return sha256(stableJson({
    repositoryId,
    pullRequestNumber: integer(input.pullRequestNumber, 'pullRequestNumber'),
    baseSha: requireSha(input.baseSha, 'baseSha'),
    headSha: requireSha(input.headSha, 'headSha'),
    generation: integer(input.generation, 'generation', 0),
    policySha: requireSha(input.policySha, 'policySha'),
    fullDiffDigest: requireDigest(input.fullDiffDigest, 'fullDiffDigest'),
    candidateDigests: candidates,
    openSetDigest: requireDigest(input.openSetDigest, 'openSetDigest'),
    unmanagedBodyDigest: requireDigest(input.unmanagedBodyDigest, 'unmanagedBodyDigest'),
  }));
}

export type IssueDecisionKind = 'resolves' | 'partial' | 'related' | 'not-related';
export type IssueDecisionConfidence = 'high' | 'medium' | 'low';
export interface IssueDecision {
  repositoryId: number;
  number: number;
  decision: IssueDecisionKind;
  confidence: IssueDecisionConfidence;
  requirements: string[];
  evidence: Array<{ requirement: number; files: string[]; explanation: string }>;
  unresolved: string[];
}
export interface IssueDecisionEnvelope { issueDecisions: IssueDecision[] }

function stringArray(value: unknown, name: string, minimumItems: number, maximumItems: number, minimumLength: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) throw new Error(`${name}无效`);
  return value.map((item, index) => singleLine(item, `${name}[${index}]`, minimumLength, maximumLength));
}

export function validateIssueDecisionEnvelope(value: unknown): IssueDecisionEnvelope {
  const root = asRecord(value, 'Copilot议题结果');
  exactKeys(root, ['issueDecisions'], 'Copilot议题结果');
  if (!Array.isArray(root.issueDecisions) || root.issueDecisions.length > 50) throw new Error('issueDecisions无效');
  const issueDecisions = root.issueDecisions.map((value, index): IssueDecision => {
    const name = `issueDecisions[${index}]`;
    const item = asRecord(value, name);
    exactKeys(item, ['repositoryId', 'number', 'decision', 'confidence', 'requirements', 'evidence', 'unresolved'], name);
    if (!['resolves', 'partial', 'related', 'not-related'].includes(item.decision as string)) throw new Error(`${name}.decision无效`);
    if (!['high', 'medium', 'low'].includes(item.confidence as string)) throw new Error(`${name}.confidence无效`);
    const requirements = stringArray(item.requirements, `${name}.requirements`, 1, 20, 1, 1_000);
    if (!Array.isArray(item.evidence) || item.evidence.length > 100 || (item.decision === 'resolves' && item.evidence.length === 0)) throw new Error(`${name}.evidence无效`);
    const evidence = item.evidence.map((value, evidenceIndex) => {
      const evidenceName = `${name}.evidence[${evidenceIndex}]`;
      const evidenceItem = asRecord(value, evidenceName);
      exactKeys(evidenceItem, ['requirement', 'files', 'explanation'], evidenceName);
      const requirement = integer(evidenceItem.requirement, `${evidenceName}.requirement`, 0);
      if (requirement >= requirements.length) throw new Error(`${evidenceName}.requirement无效`);
      return {
        requirement,
        files: stringArray(evidenceItem.files, `${evidenceName}.files`, 1, 50, 1, 1_000),
        explanation: singleLine(evidenceItem.explanation, `${evidenceName}.explanation`, 4, 2_000),
      };
    });
    const unresolved = stringArray(item.unresolved, `${name}.unresolved`, 0, 20, 1, 1_000);
    if (closingKeywords([...requirements, ...evidence.map((entry) => entry.explanation), ...unresolved].join('\n'), 'body', 0).length > 0) throw new Error(`${name}不得包含关闭关键字`);
    return {
      repositoryId: integer(item.repositoryId, `${name}.repositoryId`),
      number: integer(item.number, `${name}.number`),
      decision: item.decision as IssueDecisionKind,
      confidence: item.confidence as IssueDecisionConfidence,
      requirements,
      evidence,
      unresolved,
    };
  });
  const keys = issueDecisions.map((item) => `${item.repositoryId}:${item.number}`);
  if (new Set(keys).size !== keys.length) throw new Error('issueDecisions包含重复议题');
  return { issueDecisions };
}

export interface IssueCandidate {
  repositoryId: number;
  number: number;
  state: IssueState;
  contentDigest: string;
  unfetchedReferences: UnfetchedReference[];
}

export function selectDesiredIssueSet(envelope: IssueDecisionEnvelope, context: { targetRepositoryId: number; candidates: readonly IssueCandidate[]; changedFiles: readonly string[] }): DesiredIssueReference[] {
  const targetRepositoryId = integer(context.targetRepositoryId, 'targetRepositoryId');
  const candidates = new Map<number, IssueCandidate>();
  for (const candidate of context.candidates) {
    if (candidate.repositoryId !== targetRepositoryId) throw new Error('issue-repository-mismatch');
    integer(candidate.number, 'candidate.number');
    state(candidate.state, 'candidate.state');
    requireDigest(candidate.contentDigest, 'candidate.contentDigest');
    if (candidates.has(candidate.number)) throw new Error('候选议题包含重复编号');
    candidates.set(candidate.number, candidate);
  }
  const changedFiles = new Set(context.changedFiles.map((file, index) => singleLine(file, `changedFiles[${index}]`, 1, 1_000)));
  const desired: DesiredIssueReference[] = [];
  for (const decision of envelope.issueDecisions) {
    if (decision.repositoryId !== targetRepositoryId) throw new Error('issue-repository-mismatch');
    const candidate = candidates.get(decision.number);
    if (!candidate) throw new Error('模型返回非候选议题');
    if (decision.decision !== 'resolves' || decision.confidence !== 'high') continue;
    if (candidate.state !== 'open' || candidate.unfetchedReferences.length > 0 || decision.unresolved.length > 0) continue;
    if (decision.requirements.some((_requirement, index) => !decision.evidence.some((evidence) => evidence.requirement === index))) continue;
    if (decision.evidence.some((evidence) => evidence.files.some((file) => !changedFiles.has(file)))) continue;
    desired.push({ repositoryId: targetRepositoryId, number: decision.number });
  }
  desired.sort((left, right) => left.number - right.number);
  if (desired.length > 10) throw new Error('正式关联总数超过10个');
  return desired;
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
  const anchors = ['\n## 发布与迁移\n', '\n## 贡献者\n', '\n<!-- workflow:source-actor:']
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

export interface ClosingKeywordMatch {
  source: 'body' | 'commit';
  sourceIndex: number;
  keyword: string;
  issueReference: string;
}

function closingKeywords(value: string, source: 'body' | 'commit', sourceIndex: number): ClosingKeywordMatch[] {
  return [...value.matchAll(/\b(close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)\b/giu)]
    .map((match) => ({ source, sourceIndex, keyword: match[1]!, issueReference: match[2]! }));
}

export function detectUnmanagedClosingKeywords(input: { body: string; commitMessages: readonly string[] }): ClosingKeywordMatch[] {
  const region = extractIssueLinksBlock(input.body);
  if (region) {
    const outer = managedOuterRegion(input.body);
    if (region.start <= outer.start || region.end > outer.end) throw new Error('议题子块不在唯一外层受管区域内');
  }
  const unmanagedBody = region ? `${input.body.slice(0, region.start)}${input.body.slice(region.end)}` : input.body;
  return [
    ...closingKeywords(unmanagedBody, 'body', 0),
    ...input.commitMessages.flatMap((message, index) => closingKeywords(message, 'commit', index)),
  ];
}
