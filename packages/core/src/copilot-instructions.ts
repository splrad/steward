import { sha256Hex } from './fingerprint.js';

export const copilotInstructionProfiles = ['common', 'layerscape'] as const;
export type CopilotInstructionProfile = typeof copilotInstructionProfiles[number];
export const copilotInstructionsTargetPath = '.github/copilot-instructions.md' as const;

const syncContracts = {
  common: { targetPath: copilotInstructionsTargetPath, sourceFiles: ['common.md'] as const },
  layerscape: { targetPath: copilotInstructionsTargetPath, sourceFiles: ['common.md', 'layerscape.md'] as const },
} as const;

export function copilotInstructionSyncContract(profile: unknown): typeof syncContracts[CopilotInstructionProfile] {
  if (typeof profile !== 'string' || !Object.hasOwn(syncContracts, profile)) throw new Error('Copilot说明配置不属于允许的同步合同');
  return syncContracts[profile as CopilotInstructionProfile];
}

export function renderCopilotInstructions(common: string, project?: string | null): string {
  const base = common.trimEnd();
  if (!base) throw new Error('Copilot通用说明不能为空');
  const extra = project?.trim();
  const rendered = extra ? `${base}\n\n${extra}\n` : `${base}\n`;
  if ([...rendered].length > 4000) throw new Error('Copilot说明超过4000个字符');
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
