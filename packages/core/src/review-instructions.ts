import { sha256Hex } from './fingerprint.js';

export const reviewInstructionTargetPaths = ['AGENTS.md', '.github/copilot-instructions.md'] as const;
export type ReviewInstructionTargetPath = typeof reviewInstructionTargetPaths[number];
export type ReviewAudience = 'shared' | 'copilot';
export type ReviewProfileStatus = 'active' | 'retired';
export type ReviewRuleStatus = 'active' | 'retired';

export interface ReviewProfile {
  id: string;
  owner: string;
  status: ReviewProfileStatus;
}

export interface ReviewProfileRegistry {
  schemaVersion: 1;
  profiles: ReviewProfile[];
}

export interface ReviewRuleEvidence {
  kind: 'source' | 'pull-request' | 'commit';
  reference: string;
  confirmedAt: string;
}

export interface ReviewRule {
  id: string;
  audience: ReviewAudience;
  profiles: string[];
  scope: 'repository';
  consequence: string;
  safePath: string;
  owner: string;
  evidence: ReviewRuleEvidence[];
  status: ReviewRuleStatus;
}

export interface ReviewRuleRegistry {
  schemaVersion: 1;
  rules: ReviewRule[];
}

export interface GeneratedReviewInstruction {
  path: ReviewInstructionTargetPath;
  audience: ReviewAudience;
  content: string;
  ruleIds: string[];
  digest: string;
}

export interface GeneratedReviewInstructionSet {
  profile: string;
  files: readonly [GeneratedReviewInstruction, GeneratedReviewInstruction];
}

const profileIdPattern = /^[a-z][a-z0-9-]*$/u;
const ruleIdPattern = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u;
const ownerPattern = /^splrad\/[a-z0-9-]+$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function assertExactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}字段不符合固定合同`);
}

function assertUniqueStrings(values: unknown, label: string): asserts values is string[] {
  if (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== 'string' || !value.trim()) || new Set(values).size !== values.length) {
    throw new Error(`${label}必须是非空且不重复的字符串数组`);
  }
}

export function validateReviewRegistries(profileRegistry: ReviewProfileRegistry, ruleRegistry: ReviewRuleRegistry): ReadonlyMap<string, ReviewProfile> {
  assertExactKeys(profileRegistry, ['schemaVersion', 'profiles'], '审查profile注册表');
  if (profileRegistry.schemaVersion !== 1 || !Array.isArray(profileRegistry.profiles) || profileRegistry.profiles.length === 0) throw new Error('审查profile注册表版本或内容无效');
  const profiles = new Map<string, ReviewProfile>();
  for (const profile of profileRegistry.profiles) {
    assertExactKeys(profile, ['id', 'owner', 'status'], '审查profile');
    if (!profileIdPattern.test(profile.id) || !ownerPattern.test(profile.owner) || !['active', 'retired'].includes(profile.status)) throw new Error(`审查profile无效: ${profile.id}`);
    if (profiles.has(profile.id)) throw new Error(`审查profile重复: ${profile.id}`);
    profiles.set(profile.id, profile);
  }
  if (profiles.get('common')?.status !== 'active') throw new Error('common审查profile必须存在且保持active');

  assertExactKeys(ruleRegistry, ['schemaVersion', 'rules'], '审查规则注册表');
  if (ruleRegistry.schemaVersion !== 1 || !Array.isArray(ruleRegistry.rules) || ruleRegistry.rules.length === 0) throw new Error('审查规则注册表版本或内容无效');
  const ruleIds = new Set<string>();
  for (const rule of ruleRegistry.rules) {
    assertExactKeys(rule, ['id', 'audience', 'profiles', 'scope', 'consequence', 'safePath', 'owner', 'evidence', 'status'], '审查规则');
    assertUniqueStrings(rule.profiles, `${rule.id}的profiles`);
    if (!ruleIdPattern.test(rule.id) || !['shared', 'copilot'].includes(rule.audience) || rule.scope !== 'repository' || !ownerPattern.test(rule.owner) || !['active', 'retired'].includes(rule.status)) throw new Error(`审查规则无效: ${rule.id}`);
    if (!rule.consequence.trim() || !rule.safePath.trim()) throw new Error(`审查规则正文不能为空: ${rule.id}`);
    if (ruleIds.has(rule.id)) throw new Error(`审查规则重复: ${rule.id}`);
    ruleIds.add(rule.id);
    for (const profileId of rule.profiles) {
      const profile = profiles.get(profileId);
      if (!profile || profile.status !== 'active') throw new Error(`${rule.id}引用不存在或已退役的profile: ${profileId}`);
    }
    if (!Array.isArray(rule.evidence) || rule.evidence.length === 0) throw new Error(`${rule.id}必须包含证据`);
    const evidenceKeys = new Set<string>();
    for (const evidence of rule.evidence) {
      assertExactKeys(evidence, ['kind', 'reference', 'confirmedAt'], `${rule.id}的证据`);
      if (!['source', 'pull-request', 'commit'].includes(evidence.kind) || !evidence.reference.trim() || !datePattern.test(evidence.confirmedAt)) throw new Error(`${rule.id}的证据无效`);
      const key = `${evidence.kind}:${evidence.reference}:${evidence.confirmedAt}`;
      if (evidenceKeys.has(key)) throw new Error(`${rule.id}包含重复证据`);
      evidenceKeys.add(key);
    }
  }
  const languageRule = ruleRegistry.rules.find(rule => rule.id === 'common.review-language-zh');
  if (!languageRule || languageRule.status !== 'active' || languageRule.audience !== 'shared' || !languageRule.profiles.includes('common')) throw new Error('common.review-language-zh必须是common的active shared规则');
  return profiles;
}

function renderRules(title: string, rules: readonly ReviewRule[]): string {
  const body = rules.flatMap(rule => [`### ${rule.id}`, `- ${rule.consequence}`, `  Safe path: ${rule.safePath}`, '']);
  const joined = [`# ${title}`, '', '## Code Review Rules', '', ...body].join('\n');
  let contentEnd = joined.length;
  while (contentEnd > 0 && joined.charCodeAt(contentEnd - 1) === 10) contentEnd -= 1;
  const rendered = `${joined.slice(0, contentEnd)}\n`;
  if (!rendered.trim()) throw new Error('审查说明不能为空');
  if (rendered.includes('\r')) throw new Error('审查说明必须使用LF换行');
  if ([...rendered].length > 4000) throw new Error('审查说明超过4000个字符');
  return rendered;
}

export async function generateReviewInstructionSet(profileId: unknown, profileRegistry: ReviewProfileRegistry, ruleRegistry: ReviewRuleRegistry): Promise<GeneratedReviewInstructionSet> {
  const profiles = validateReviewRegistries(profileRegistry, ruleRegistry);
  if (typeof profileId !== 'string' || profiles.get(profileId)?.status !== 'active') throw new Error('仓库引用不存在或已退役的审查profile');
  const selected = ruleRegistry.rules
    .filter(rule => rule.status === 'active' && (rule.profiles.includes('common') || rule.profiles.includes(profileId)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const shared = selected.filter(rule => rule.audience === 'shared');
  const copilot = selected.filter(rule => rule.audience === 'copilot');
  if (!shared.length || !copilot.length) throw new Error('审查profile必须同时生成共享规则和Copilot补充规则');
  const sharedContent = renderRules('SPLRAD 仓库说明', shared);
  const copilotContent = renderRules('SPLRAD Copilot 代码审查补充说明', copilot);
  return {
    profile: profileId,
    files: [
      { path: 'AGENTS.md', audience: 'shared', content: sharedContent, ruleIds: shared.map(rule => rule.id), digest: await sha256Hex(sharedContent) },
      { path: '.github/copilot-instructions.md', audience: 'copilot', content: copilotContent, ruleIds: copilot.map(rule => rule.id), digest: await sha256Hex(copilotContent) },
    ],
  };
}

export interface ReviewSyncPlanInput {
  current: Partial<Record<ReviewInstructionTargetPath, string | null>>;
  generated: GeneratedReviewInstructionSet;
  branchExists: boolean;
  branchOwnedBySteward: boolean;
  openPullRequests: number;
}

export function planReviewInstructionSync(input: ReviewSyncPlanInput): 'unchanged' | 'create' | 'update' {
  if (input.generated.files.every(file => input.current[file.path] === file.content)) return 'unchanged';
  if (!input.branchExists) return 'create';
  if (!input.branchOwnedBySteward || input.openPullRequests !== 1) throw new Error('审查说明受管分支或拉取请求存在冲突');
  return 'update';
}
