/** Native safe-settings evidence; kept in the repository to which the details belong. */
export interface SettingsReport {
  schemaVersion: 1; repositoryId: number; repository: string; runId: number; runAttempt: number;
  controllerSha: string; upstreamSha: string; observedAt: string; mode: 'NOP' | 'APPLY';
  status: 'success' | 'failure'; entries: { kind: 'result' | 'error'; value: string }[];
}
export function decodeSettingsReport(value: unknown, repositoryId: number, path: string): SettingsReport {
  const fail = (): never => { throw new Error('SETTINGS_REPORT_INVALID'); };
  const record = value as SettingsReport;
  if (!record || Object.keys(record).sort().join(',') !== 'controllerSha,entries,mode,observedAt,repository,repositoryId,runAttempt,runId,schemaVersion,status,upstreamSha'
    || record.schemaVersion !== 1 || record.repositoryId !== repositoryId
    || ![record.repositoryId,record.runId,record.runAttempt].every(v => Number.isSafeInteger(v) && v > 0)
    || !/^splrad\/[A-Za-z0-9_.-]+$/.test(record.repository) || !/^[a-f0-9]{40}$/.test(record.controllerSha)
    || !/^[a-f0-9]{40}$/.test(record.upstreamSha) || !Number.isFinite(Date.parse(record.observedAt))
    || new Date(record.observedAt).toISOString() !== record.observedAt || !['NOP','APPLY'].includes(record.mode)
    || !['success','failure'].includes(record.status) || path !== `settings/${record.runId}-${record.runAttempt}.json`
    || !Array.isArray(record.entries) || record.entries.length === 0) return fail();
  for (const entry of record.entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'kind,value' || !['result','error'].includes(entry.kind) || typeof entry.value !== 'string') return fail();
    let native: any; try { native = JSON.parse(entry.value); } catch { return fail(); }
    if (!native || typeof native !== 'object' || Array.isArray(native) || native.repo !== record.repository.slice('splrad/'.length)
      || native.owner !== undefined && native.owner !== 'splrad') return fail();
  }
  return structuredClone(record);
}
