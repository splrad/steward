import { sha256Hex } from './fingerprint.js';

const requiredFragments = [
  '简体中文', '当前拉取请求差异', '直接证据', '正确性', '安全', '兼容性', '构建', '部署', '发布',
  '不提出命名、格式、个人偏好、非必要重构或主观可读性意见',
];

export function renderCopilotInstructions(common: string, project?: string | null): string {
  const base = common.trimEnd();
  const extra = project?.trim();
  const rendered = extra ? `${base}\n\n${extra}\n` : `${base}\n`;
  if ([...rendered].length > 4000) throw new Error('Copilot说明超过4000个字符');
  for (const fragment of requiredFragments) if (!rendered.includes(fragment)) throw new Error(`Copilot说明缺少固定内容: ${fragment}`);
  return rendered;
}

export function computeCopilotInstructionsDigest(content: string): Promise<string> {
  return sha256Hex(content);
}

export interface CopilotSyncPlanInput { current?: string | null; generated: string; branchExists: boolean; branchOwnedBySteward: boolean; openPullRequests: number }
export function planCopilotInstructionsSync(input: CopilotSyncPlanInput): 'unchanged' | 'create' | 'update' {
  if (input.current === input.generated) return 'unchanged';
  if (!input.branchExists) return 'create';
  if (!input.branchOwnedBySteward || input.openPullRequests !== 1) throw new Error('Copilot说明受管分支或拉取请求存在冲突');
  return 'update';
}
