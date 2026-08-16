import { sha256Hex } from './fingerprint.js';

const requiredFragments = [
  '严重程度：阻断', '严重程度：建议', '标题：', '问题：', '证据：', '影响：', '建议：',
  '未发现需要阻断合并的问题。', '发现需要修复后再合并的问题',
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
