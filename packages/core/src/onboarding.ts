import { renderManagedBody, type GeneratedSummary } from './automation.js';

export interface RepositoryForOnboarding {
  id: number; fullName: string; ownerId: number; visibility: 'public' | 'private';
  fork: boolean; archived: boolean; disabled: boolean; defaultBranch?: string | null;
}
export interface OnboardingConfiguration { managed: boolean; copilotInstructionsProfile?: string; classificationProfile?: string; validationProfile?: string; releaseProfile?: string | null }
export interface RepositorySettings { allow_squash_merge: true; allow_merge_commit: false; allow_rebase_merge: false; allow_auto_merge: false; delete_branch_on_merge: true }

export function validateRepositoryForOnboarding(repository: RepositoryForOnboarding, organizationId: number, configuration: OnboardingConfiguration): 'ready' | 'waiting-for-default-branch' {
  if (repository.ownerId !== organizationId || !repository.fullName.startsWith('splrad/')) throw new Error('仓库不属于目标组织');
  if (repository.fork || repository.archived || repository.disabled) throw new Error('派生、归档或禁用仓库不能接入');
  if (!configuration.managed) throw new Error('仓库没有有效的中央纳管配置');
  if (repository.visibility === 'private' && (!configuration.classificationProfile || !configuration.validationProfile || !configuration.copilotInstructionsProfile)) throw new Error('私有仓库必须先配置专用覆盖');
  return repository.defaultBranch ? 'ready' : 'waiting-for-default-branch';
}

export function planRepositorySettings(): RepositorySettings {
  return { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: false, delete_branch_on_merge: true };
}

export function renderOnboardingPullRequest(input: { template: string; configuration: Required<Pick<OnboardingConfiguration, 'copilotInstructionsProfile' | 'classificationProfile' | 'validationProfile'>> & Pick<OnboardingConfiguration, 'releaseProfile'>; actor: string; context: string }): { title: string; body: string; branch: string } {
  const generated: GeneratedSummary = {
    type: 'chore', scope: 'steward', title: '接入中央仓库管理',
    summary: '将本仓库接入SPLRAD Steward中央自动化并应用统一仓库设置。',
    changes: [
      `使用${input.configuration.classificationProfile}分类配置和${input.configuration.validationProfile}验证配置`,
      `生成${input.configuration.copilotInstructionsProfile}代码审查说明并设置压缩合并和来源分支清理`,
      input.configuration.releaseProfile ? `启用${input.configuration.releaseProfile}中央发布配置` : '本仓库不启用中央发布配置',
    ], reviewNotes: ['请确认组织规则集、维护者权限和五项仓库设置均已生效'],
  };
  return { title: 'chore(steward): 接入中央仓库管理', branch: 'steward/repository-onboarding', body: renderManagedBody({ generated, templateBody: input.template, actor: input.actor, contributors: [], context: input.context }) };
}

export function verifyOnboardingReadback(actual: Partial<RepositorySettings>, expectedInstructions: string, actualInstructions: string, workflowPaths: readonly string[], allowedWorkflowPaths: readonly string[]): boolean {
  const settings = planRepositorySettings();
  for (const [key, value] of Object.entries(settings)) if (actual[key as keyof RepositorySettings] !== value) return false;
  if (actualInstructions !== expectedInstructions) return false;
  return workflowPaths.every((path) => allowedWorkflowPaths.includes(path));
}
