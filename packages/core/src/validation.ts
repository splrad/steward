export type ValidationTask = 'git-diff-check' | 'parse-json' | 'parse-yaml' | 'verify-copilot-instructions' | 'actionlint-if-present' | 'actionlint' | 'parse-powershell' | 'parse-msbuild-xml' | 'npm-ci' | 'npm-test' | 'npm-typecheck' | 'npm-verify-dist' | 'npm-verify-workflows';
export interface ValidationProfile { runner: 'ubuntu-latest'; timeoutMinutes: number; tasks: ValidationTask[]; powershellFiles?: string[]; msbuildFiles?: string[]; nodeVersionFile?: string; disclosure: { productBuild: string; productTests: string } }
export interface ValidationResult { task: ValidationTask; state: 'success' | 'failure' | 'not-applicable'; detail: string }

export function selectValidationProfile(repositoryId: number, catalog: { repositories: Record<string, { validationProfile: string }>; defaultPublicProfile: string }, isPrivate: boolean): string {
  const selected = catalog.repositories[String(repositoryId)]?.validationProfile;
  if (selected) return selected;
  if (isPrivate) throw new Error('私有仓库尚未纳管');
  return catalog.defaultPublicProfile;
}

export async function runValidationTasks(profile: ValidationProfile, execute: (task: ValidationTask) => Promise<Omit<ValidationResult, 'task'>>): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const task of profile.tasks) {
    try { results.push({ task, ...await execute(task) }); }
    catch (error) { results.push({ task, state: 'failure', detail: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

export function renderValidationSummary(profile: ValidationProfile, results: readonly ValidationResult[]): string {
  const icon = { success: '✅', failure: '❌', 'not-applicable': '➖' } as const;
  return ['# SPLRAD Steward / PR Validation', '', ...results.map((result) => `- ${icon[result.state]} ${result.task}: ${result.detail}`), '', `- 产品构建：${profile.disclosure.productBuild}`, `- 产品测试：${profile.disclosure.productTests}`, ''].join('\n');
}
