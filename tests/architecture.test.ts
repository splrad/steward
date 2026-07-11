import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve('packages');
const allowedDependencies: Record<string, ReadonlySet<string>> = {
  manifest: new Set<string>(),
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
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const [name] = relative.split(path.sep);
  return name || null;
}

function importedPackage(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(file), specifier);
  return packageName(resolved);
}

function importSpecifiers(source: string): string[] {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: { kind: SyntaxKind; value: string }[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens.push({ kind, value: scanner.getTokenValue() });
  }
  const specifiers: string[] = [];
  function addString(index: number): boolean {
    const token = tokens[index];
    if (token?.kind !== SyntaxKind.StringLiteral) return false;
    specifiers.push(token.value);
    return true;
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === SyntaxKind.ImportKeyword) {
      if (addString(index + 1)) continue;
      if (tokens[index + 1]?.kind === SyntaxKind.OpenParenToken && addString(index + 2)) continue;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        if (tokens[cursor]?.kind === SyntaxKind.SemicolonToken) break;
        if (tokens[cursor]?.kind === SyntaxKind.FromKeyword && addString(cursor + 1)) break;
      }
    } else if (token?.kind === SyntaxKind.ExportKeyword) {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        if (tokens[cursor]?.kind === SyntaxKind.SemicolonToken) break;
        if (tokens[cursor]?.kind === SyntaxKind.FromKeyword && addString(cursor + 1)) break;
      }
    } else if ((token?.kind === SyntaxKind.RequireKeyword
      || (token?.kind === SyntaxKind.Identifier && token.value === 'require'))
      && tokens[index - 1]?.kind !== SyntaxKind.DotToken
      && tokens[index + 1]?.kind === SyntaxKind.OpenParenToken) {
      addString(index + 2);
    }
  }
  return specifiers;
}

describe('architecture boundary', () => {
  it('requires every package directory to declare its dependency policy', async () => {
    const packageDirectories = (await readdir(packageRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(packageDirectories).toEqual(Object.keys(allowedDependencies).sort());
  });

  it('keeps Steward package dependencies pointing toward policy', async () => {
    const files = await sourceFiles(packageRoot);
    const violations: string[] = [];
    for (const file of files) {
      const sourcePackage = packageName(file);
      if (!sourcePackage) continue;
      const source = await readFile(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const targetPackage = importedPackage(file, specifier);
        if (!targetPackage || targetPackage === sourcePackage) continue;
        if (!allowedDependencies[sourcePackage]?.has(targetPackage)) {
          violations.push(`${path.relative('.', file)}: ${sourcePackage} must not import ${targetPackage}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('recognizes every supported module-loading form without reading comments', () => {
    expect(importSpecifiers([
      "import type { A } from '../manifest/src/types.js';",
      "import './register.js';",
      "export { helper } from '../core/src/index.js';",
      "const module = await import('../github/src/index.js');",
      "import legacy = require('../relay/src/index.js');",
      "const commonJs = require('../cli/src/index.js');",
      "// import '../ignored/src/index.js';",
    ].join('\n'))).toEqual([
      '../manifest/src/types.js',
      './register.js',
      '../core/src/index.js',
      '../github/src/index.js',
      '../relay/src/index.js',
      '../cli/src/index.js',
    ]);
  });

  it('keeps policy packages pure and caller-supplied', async () => {
    const violations: string[] = [];
    for (const policyPackage of ['core', 'manifest']) {
      const sourceDirectory = path.join(packageRoot, policyPackage, 'src');
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
});
