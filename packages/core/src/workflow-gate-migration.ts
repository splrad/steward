/** Produces an offline proposal only. It never writes GitHub rules or authorizes activation. */
export function planWorkflowGateMigration(current: any, input: {
  repositoryId: number; workflowPath: string; evaluatorSha: string; gateName: string; appId: number;
}): {before: any; after: any} {
  if (current?.enforcement !== 'active' || !Array.isArray(current.bypass_actors) || current.bypass_actors.length
    || !Array.isArray(current.rules)) throw new Error('MIGRATION_SOURCE: active non-bypass ruleset required');
  if (!/^[a-f0-9]{40}$/.test(input.evaluatorSha) || !Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
    || !Number.isSafeInteger(input.appId) || input.appId <= 0 || !input.gateName
    || !/^\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/.test(input.workflowPath)) throw new Error('MIGRATION_INPUT: invalid immutable identity');
  const before = structuredClone(current), after = structuredClone(current);
  const workflowRules = after.rules.filter((r:any) => r.type === 'workflows');
  const matches = workflowRules.flatMap((r:any) => r.parameters?.workflows ?? [])
    .filter((w:any) => w.repository_id === input.repositoryId && w.path === input.workflowPath);
  if (matches.length !== 1) throw new Error('MIGRATION_SOURCE: expected one trusted workflow');
  delete matches[0].ref;
  matches[0].sha = input.evaluatorSha;
  const statusRules = after.rules.filter((r:any) => r.type === 'required_status_checks');
  if (statusRules.length !== 1 || !Array.isArray(statusRules[0].parameters?.required_status_checks)) throw new Error('MIGRATION_SOURCE: status contract ambiguous');
  const checks = statusRules[0].parameters.required_status_checks;
  const existing = checks.filter((c:any) => c.context === input.gateName);
  if (existing.length > 1 || (existing.length === 1 && existing[0].integration_id !== input.appId)) throw new Error('MIGRATION_SOURCE: gate ownership mismatch');
  if (!existing.length) checks.push({context:input.gateName,integration_id:input.appId});
  return {before,after};
}
