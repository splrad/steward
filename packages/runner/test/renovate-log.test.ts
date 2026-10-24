import { expect, it } from 'vitest';
const { verifyRenovateLog } = await import(new URL('../../../scripts/verify-renovate-log.mjs', import.meta.url).href);
const complete = JSON.stringify({ level: 30, msg: 'Repository finished' });
it('requires native completion without suppressed warnings', () => expect(() => verifyRenovateLog(complete)).not.toThrow());
it.each(['', 'invalid', JSON.stringify({level:30,msg:'Repository started'}), ...[
  'Could not parse mise version output', 'Failed to determine mise version', '`mise lock` requires either safe mode or unsafe execution', 'lock update skipped',
].map(msg => JSON.stringify({level:20,msg}) + '\n' + complete), JSON.stringify({level:40,msg:'unrecognized warning'}) + '\n' + complete])('blocks incomplete or skipped native updates', text => expect(() => verifyRenovateLog(text)).toThrow());
