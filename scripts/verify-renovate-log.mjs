import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export function verifyRenovateLog(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) throw new Error('RENOVATE_BLOCKED: missing native execution evidence');
  let finished = false;
  for (const line of lines) {
    const record = JSON.parse(line);
    if (!record || typeof record.msg !== 'string' || !Number.isInteger(record.level)) throw new Error('RENOVATE_BLOCKED: invalid structured log');
    if (record.level >= 40 || /Could not parse mise version output|Failed to determine mise version|mise lock.*requires|artifact.*(?:error|fail)|lock.*(?:skip|fail)/i.test(record.msg)) throw new Error('RENOVATE_BLOCKED: native warning, error or skipped lock operation');
    if (record.msg === 'Repository finished') finished = true;
  }
  if (!finished) throw new Error('RENOVATE_BLOCKED: repository completion missing');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { verifyRenovateLog(await readFile(process.argv[2], 'utf8')); console.log('Renovate native run verified'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
