import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve('packages');
const allowedDependencies: Record<string, ReadonlySet<string>> = {
  manifest: new Set(),
  core: new Set(['manifest']),
  github: new Set(['core', 'manifest']),
  relay: new Set(['core', 'github', 'manifest']),
  cli: new Set(['core', 'github', 'manifest']),
};

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (/\.ts$/.test(entry.name)) files.push(child);
  }
  return files;
}

function packageName(file: string): string | null {
  const relative = path.relative(packageRoot, file);
  const [name] = relative.split(path.sep);
  return name && Object.hasOwn(allowedDependencies, name) ? name : null;
}

function importedPackage(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(file), specifier);
  return packageName(resolved);
}

describe('architecture boundary', () => {
  it('keeps Steward package dependencies pointing toward policy', async () => {
    const files = await sourceFiles(packageRoot);
    const violations: string[] = [];
    for (const file of files) {
      const sourcePackage = packageName(file);
      if (!sourcePackage) continue;
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
        const targetPackage = importedPackage(file, match[2] ?? '');
        if (!targetPackage || targetPackage === sourcePackage) continue;
        if (!allowedDependencies[sourcePackage]?.has(targetPackage)) {
          violations.push(`${path.relative('.', file)}: ${sourcePackage} must not import ${targetPackage}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps policy packages pure and caller-supplied', async () => {
    const violations: string[] = [];
    for (const packageName of ['core', 'manifest']) {
      const sourceDirectory = path.join(packageRoot, packageName, 'src');
      for (const file of await sourceFiles(sourceDirectory)) {
        const source = await readFile(file, 'utf8');
        for (const [pattern, label] of [
          [/\bprocess\.env\b/, 'process environment'],
          [/\bfetch\s*\(/, 'network fetch'],
          [/node:(?:child_process|cluster|net|tls)/, 'process or socket API'],
          [/@actions\//, 'GitHub Actions runtime'],
        ] as const) {
          if (pattern.test(source)) violations.push(`${path.relative('.', file)}: forbidden ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('publishes the normative architecture and reference checklist', async () => {
    const overview = await readFile('docs/architecture/README.md', 'utf8');
    const references = await readFile('docs/architecture/reference-baseline.md', 'utf8');
    for (const heading of [
      '## System boundary',
      '## Architecture planes',
      '## Dependency direction',
      '## Trusted data flow',
      '## Version and compatibility model',
      '## Extension model',
      '## Failure and presentation semantics',
      '## Permissions and credentials',
      '## Deployment topology',
      '## Definition of done for a shared module',
    ]) expect(overview).toContain(heading);
    for (const reference of ['.NET Arcade', 'Kubernetes Prow', 'GitHub reusable automation']) {
      expect(references).toContain(`## ${reference}`);
    }
  });
});
