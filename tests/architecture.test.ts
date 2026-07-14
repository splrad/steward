import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve('packages');
const workerPortablePackages = new Set(['core', 'github', 'manifest', 'control']);
const nodeBuiltinModules = new Set(builtinModules.map((module) => module.replace(/^node:/, '')));
const forbiddenWorkerGlobals = new Set(['Buffer', 'NodeJS', 'fetch', 'process']);
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

interface SourceToken {
  kind: SyntaxKind;
  value: string;
}

function sourceTokens(source: string): SourceToken[] {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: SourceToken[] = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens.push({ kind, value: scanner.getTokenValue() });
  }
  return tokens;
}

function staticStringToken(token: SourceToken | undefined): token is SourceToken {
  return token?.kind === SyntaxKind.StringLiteral
    || token?.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

function importSpecifiers(source: string): string[] {
  const tokens = sourceTokens(source);
  const specifiers: string[] = [];
  function addString(index: number): boolean {
    const token = tokens[index];
    if (!staticStringToken(token)) return false;
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

function identifierNames(source: string): Set<string> {
  const identifiers = new Set<string>();
  for (const token of sourceTokens(source)) {
    if (token.kind === SyntaxKind.Identifier) identifiers.add(token.value);
  }
  return identifiers;
}

function isNodeBuiltinSpecifier(specifier: string): boolean {
  const normalized = specifier.replace(/^node:/, '');
  return nodeBuiltinModules.has(normalized)
    || [...nodeBuiltinModules].some((module) => normalized.startsWith(`${module}/`));
}

function workerRuntimeUses(source: string, options: { allowFetch?: boolean } = {}): string[] {
  const uses = new Set<string>();
  for (const specifier of importSpecifiers(source)) {
    if (isNodeBuiltinSpecifier(specifier)) uses.add(`Node built-in module ${specifier}`);
    if (specifier.startsWith('@actions/')) uses.add(`GitHub Actions runtime ${specifier}`);
  }
  const identifiers = identifierNames(source);
  for (const identifier of forbiddenWorkerGlobals) {
    if (identifier === 'fetch' && options.allowFetch) continue;
    if (identifiers.has(identifier)) uses.add(`forbidden global ${identifier}`);
  }
  const tokens = sourceTokens(source);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === SyntaxKind.ImportKeyword
      && tokens[index + 1]?.kind === SyntaxKind.OpenParenToken) {
      const argument = tokens[index + 2];
      const afterArgument = tokens[index + 3]?.kind;
      if (!staticStringToken(argument)
        || (afterArgument !== SyntaxKind.CloseParenToken && afterArgument !== SyntaxKind.CommaToken)) {
        uses.add('non-literal dynamic import');
      }
    }
    if (token?.kind === SyntaxKind.RequireKeyword
      || (token?.kind === SyntaxKind.Identifier && token.value === 'require')) {
      uses.add('CommonJS require');
    }
    if (token?.kind !== SyntaxKind.OpenBracketToken) continue;
    const receiver = tokens[index - 1];
    const property = tokens[index + 1];
    const closesAccess = tokens[index + 2]?.kind === SyntaxKind.CloseBracketToken;
    const receiverCanBeMember = receiver?.kind === SyntaxKind.Identifier
      || receiver?.kind === SyntaxKind.ThisKeyword
      || receiver?.kind === SyntaxKind.CloseParenToken
      || receiver?.kind === SyntaxKind.CloseBracketToken;
    if (receiver?.kind === SyntaxKind.Identifier
      && ['globalThis', 'self'].includes(receiver.value)) {
      uses.add('computed global access');
    } else if (receiverCanBeMember && closesAccess && staticStringToken(property)
      && forbiddenWorkerGlobals.has(property.value)) {
      uses.add(`computed forbidden global ${property.value}`);
    }
  }
  return [...uses].sort();
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

  it('allows the Action to depend on policy and GitHub adapters only', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(path.resolve('action/src'))) {
      const source = await readFile(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const targetPackage = importedPackage(file, specifier);
        if (targetPackage && !['core', 'github', 'manifest'].includes(targetPackage)) {
          violations.push(`${path.relative('.', file)}: action must not import ${targetPackage}`);
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
      "const templateModule = await import(`../github/src/index.js`);",
      "import legacy = require('../relay/src/index.js');",
      "const commonJs = require('../cli/src/index.js');",
      "// import '../ignored/src/index.js';",
    ].join('\n'))).toEqual([
      '../manifest/src/types.js',
      './register.js',
      '../core/src/index.js',
      '../github/src/index.js',
      '../github/src/index.js',
      '../relay/src/index.js',
      '../cli/src/index.js',
    ]);
  });

  it('recognizes Worker runtime violations without reading comments or strings', () => {
    expect(workerRuntimeUses([
      "import 'node:crypto';",
      "import buffer from 'buffer';",
      "import actions from '@actions/core';",
      'const hidden = await import(`node:crypto`);',
      'const dynamic = await import(moduleName);',
      'const bytes = Buffer.from(value);',
      'const environment = process.env;',
      'const typed = {} as NodeJS.Process;',
      'void fetch(url);',
      "void globalThis['fetch'](url);",
      'const commonJs = require(moduleName);',
    ].join('\n'))).toEqual([
      'CommonJS require',
      'GitHub Actions runtime @actions/core',
      'Node built-in module buffer',
      'Node built-in module node:crypto',
      'computed global access',
      'forbidden global Buffer',
      'forbidden global NodeJS',
      'forbidden global fetch',
      'forbidden global process',
      'non-literal dynamic import',
    ]);
    expect(workerRuntimeUses([
      '// Buffer process fetch NodeJS',
      "const documentation = 'node:crypto @actions/core';",
      "const propertyNames = ['fetch', 'process'];",
    ].join('\n'))).toEqual([]);
  });

  it('keeps Worker runtime packages portable and caller-supplied', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(packageRoot)) {
      const sourcePackage = packageName(file);
      if (!sourcePackage || !workerPortablePackages.has(sourcePackage)) continue;
      const source = await readFile(file, 'utf8');
      for (const use of workerRuntimeUses(source, { allowFetch: sourcePackage === 'github' })) {
        violations.push(`${path.relative('.', file)}: ${use}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
