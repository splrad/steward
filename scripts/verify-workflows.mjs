import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const roots = ['.github/workflows', 'templates', 'scripts', 'packages'];
const forbidden = [
  [/^\s*schedule\s*:/m, 'scheduled workflow trigger'],
  [/\bStart-Sleep\b/i, 'Start-Sleep'],
  [/(^|\s)sleep\s+\d/im, 'sleep command'],
  [/\bAtomics\.wait\b/, 'Atomics.wait'],
  [/\bsetInterval\s*\(/, 'setInterval'],
  [/\bsetTimeout\s*\(/, 'setTimeout'],
  [/\bwhile\s*\([^)]*(?:Date\.now|deadline|elapsed|timeout)/i, 'time-based while loop'],
  [/\b(?:WAIT|POLL)(?:_|\b)/, 'wait/poll configuration'],
];

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(child));
    else if (/\.(?:[cm]?js|ts|ya?ml)$/.test(entry.name)) result.push(child);
  }
  return result;
}

const files = (await Promise.all(roots.map(sourceFiles))).flat();
const errors = [];
for (const file of files) {
  if (path.basename(file) === 'verify-workflows.mjs') continue;
  const source = await readFile(file, 'utf8');
  for (const [pattern, label] of forbidden) {
    if (label === 'scheduled workflow trigger'
      && !file.startsWith(path.normalize('.github/workflows'))
      && !file.startsWith(path.normalize('templates/thin-workflows'))
      && !file.includes(`${path.sep}templates${path.sep}thin-workflows${path.sep}`)) continue;
    if (pattern.test(source)) errors.push(`${file}: forbidden ${label}`);
  }

  if (file.startsWith(path.normalize('.github/workflows'))
    || file.startsWith(path.normalize('templates/thin-workflows'))) {
    for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
      const reference = match[1];
      if (reference?.startsWith('./')) continue;
      if (file.startsWith(path.normalize('templates/thin-workflows')) && /@__STEWARD_SHA__$/.test(reference ?? '')) continue;
      if (!/@[0-9a-f]{40}$/i.test(reference ?? '')) {
        errors.push(`${file}: action reference must use a complete commit SHA: ${reference}`);
      }
    }
  }
}

if (errors.length) throw new Error(errors.join('\n'));

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
for (const section of ['dependencies', 'devDependencies']) {
  for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
      errors.push(`package.json: ${section}.${name} must use an exact version: ${version}`);
    }
  }
}

if (errors.length) throw new Error(errors.join('\n'));
