import { expect, it } from 'vitest';
const { verifyRenovateLog } = await import(new URL('../../../scripts/verify-renovate-log.mjs', import.meta.url).href);
const complete = JSON.stringify({ level: 30, msg: 'Repository finished' });
it('requires native completion without suppressed warnings', () => expect(() => verifyRenovateLog(complete)).not.toThrow());
it.each(['', 'invalid', JSON.stringify({level:30,msg:'Repository started'}), ...[
  'Could not parse mise version output', 'Failed to determine mise version', 'No mise lock file found', '`mise lock` requires either safe mode or unsafe execution', 'lock update skipped',
].map(msg => JSON.stringify({level:20,msg}) + '\n' + complete), JSON.stringify({level:40,msg:'unrecognized warning'}) + '\n' + complete])('blocks incomplete or skipped native updates', text => expect(() => verifyRenovateLog(text)).toThrow());
const skippedSidecar = '\u001b[2mmise\u001b[0m \u001b[33mWARN\u001b[0m pypi:pyflakes dependency graph skipped: uv >= 0.12.10 is unavailable; install uv and run `mise lock` again';
it.each([
  { level:20, msg:'exec completed', stderr:skippedSidecar },
  { level:20, msg:'exec completed', stdout:skippedSidecar },
  { level:20, msg:'rawExec err', err:{ stderr:skippedSidecar } },
])('blocks warnings nested in successful subprocess records', record => expect(() => verifyRenovateLog(JSON.stringify(record) + '\n' + complete)).toThrow());
it('accepts successful native lock output', () => expect(() => verifyRenovateLog(JSON.stringify({level:20,msg:'exec completed',stderr:'mise lock 24 targets checked\n',stdout:''})+'\n'+complete)).not.toThrow());
