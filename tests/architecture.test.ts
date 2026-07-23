import { readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import {
  type Node,
  type SourceFile,
  SyntaxKind,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
} from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API, type Program, type Snapshot } from 'typescript/unstable/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = path.resolve('packages');
const workerPortablePackages = new Set(['core', 'github', 'manifest', 'control']);
const nodeBuiltinModules = new Set(builtinModules.map((module) => module.replace(/^node:/, '')));
const forbiddenWorkerGlobals = new Set(['Buffer', 'NodeJS', 'fetch', 'process']);
const allowedDependencies: Record<string, ReadonlySet<string>> = {
  manifest: new Set<string>(),
  core: new Set(['manifest']),
  github: new Set(['core', 'manifest']),
  control: new Set(['core', 'github', 'manifest']),
  'control-runtime': new Set(['control', 'core', 'github', 'manifest']),
  coordinator: new Set(['core']),
  ingress: new Set(['core']),
  relay: new Set(['core', 'github', 'manifest']),
  cli: new Set(['core', 'github', 'manifest']),
};
const allowedRuntimeDependencies: Record<string, ReadonlySet<string>> = {
  manifest: new Set(['ajv', 'ajv-formats']),
  core: new Set<string>(),
  github: new Set<string>(),
  control: new Set<string>(),
  'control-runtime': new Set<string>(),
  coordinator: new Set(['cloudflare:workers']),
  ingress: new Set<string>(),
  relay: new Set(['@octokit/auth-app']),
  cli: new Set(['ajv', 'ajv-formats', 'libsodium-wrappers']),
};
const allowedExternalResources: Record<string, ReadonlySet<string>> = {
  manifest: new Set([path.resolve('schema/steward.schema.json')]),
  core: new Set<string>(),
  github: new Set<string>(),
  control: new Set<string>(),
  'control-runtime': new Set<string>(),
  coordinator: new Set<string>(),
  ingress: new Set<string>(),
  relay: new Set<string>(),
  cli: new Set<string>(),
};

let architectureApi: API | undefined;
let architectureSnapshot: Snapshot | undefined;
let architecturePrograms: readonly Program[] = [];

beforeAll(() => {
  // A raw scanner cannot supply parser-driven regexp and template rescans; the Program AST is the gate.
  architectureApi = new API({ cwd: path.resolve('.') });
  const projectConfigs = [
    path.resolve('tsconfig.json'),
    path.resolve('tsconfig.runtime.json'),
    path.resolve('packages/relay/tsconfig.json'),
  ];
  architectureSnapshot = architectureApi.updateSnapshot({
    openProjects: projectConfigs,
  });
  architecturePrograms = projectConfigs.map((config) => {
    const program = architectureSnapshot?.getProject(config)?.program;
    if (!program) throw new Error(`TypeScript did not load architecture project ${config}`);
    return program;
  });
});

afterAll(() => {
  architectureSnapshot?.dispose();
  architectureApi?.close();
});

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

function relativeDependencyViolation(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const sourcePackage = packageName(file);
  if (!sourcePackage) return null;
  const resolved = path.resolve(path.dirname(file), specifier);
  const targetPackage = packageName(resolved);
  if (!targetPackage) {
    if (allowedExternalResources[sourcePackage]?.has(resolved)) return null;
    return `${sourcePackage} relative import ${specifier} resolves outside packages`;
  }
  if (targetPackage === sourcePackage || allowedDependencies[sourcePackage]?.has(targetPackage)) return null;
  return `${sourcePackage} must not import ${targetPackage}`;
}

function runtimeDependencyName(specifier: string): string | null {
  if (specifier.startsWith('.') || isNodeBuiltinSpecifier(specifier)) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier;
}

function sourceFile(file: string): SourceFile {
  for (const program of architecturePrograms) {
    const source = program.getSourceFile(file);
    if (source) return source;
  }
  throw new Error(`TypeScript Program did not include ${file}`);
}

function fixtureSourceFile(source: string): SourceFile {
  const root = path.resolve('.architecture-fixture').replaceAll('\\', '/');
  const configFile = `${root}/tsconfig.json`;
  const sourceFileName = `${root}/fixture.ts`;
  const api = new API({
    cwd: root,
    fs: createVirtualFileSystem({
      [configFile]: JSON.stringify({
        compilerOptions: { module: 'ESNext', noLib: true, target: 'ESNext' },
        files: ['fixture.ts'],
      }),
      [sourceFileName]: source,
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configFile] });
    try {
      const program = snapshot.getProjects()[0]?.program;
      const parsed = program?.getSourceFile(sourceFileName);
      if (!program || !parsed) throw new Error('TypeScript did not parse the architecture fixture');
      const diagnostics = program.getSyntacticDiagnostics(sourceFileName);
      if (diagnostics.length > 0) {
        throw new Error(`Architecture fixture has ${diagnostics.length} syntax diagnostic(s)`);
      }
      return parsed;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function visitSource(source: SourceFile, visitor: (node: Node) => void): void {
  function visit(node: Node): void {
    visitor(node);
    node.forEachChild(visit);
  }
  visit(source);
}

function staticStringValue(node: Node | undefined): string | null {
  return node && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function importSpecifiers(source: SourceFile): string[] {
  const specifiers: string[] = [];
  function add(node: Node | undefined): void {
    const value = staticStringValue(node);
    if (value !== null) specifiers.push(value);
  }
  visitSource(source, (node) => {
    if (isImportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (isCallExpression(node)
      && (node.expression.kind === SyntaxKind.ImportKeyword
        || (isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0]);
    }
  });
  return specifiers;
}

function isNodeBuiltinSpecifier(specifier: string): boolean {
  const normalized = specifier.replace(/^node:/, '');
  return nodeBuiltinModules.has(normalized)
    || [...nodeBuiltinModules].some((module) => normalized.startsWith(`${module}/`));
}

function workerRuntimeUses(source: SourceFile, options: { allowFetch?: boolean } = {}): string[] {
  const uses = new Set<string>();
  for (const specifier of importSpecifiers(source)) {
    if (isNodeBuiltinSpecifier(specifier)) uses.add(`Node built-in module ${specifier}`);
    if (specifier.startsWith('@actions/')) uses.add(`GitHub Actions runtime ${specifier}`);
  }
  visitSource(source, (node) => {
    if (isIdentifier(node) && forbiddenWorkerGlobals.has(node.text)
      && (node.text !== 'fetch' || !options.allowFetch)) {
      uses.add(`forbidden global ${node.text}`);
    }
    if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      uses.add('CommonJS require');
    }
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword
      && staticStringValue(node.arguments[0]) === null) {
      uses.add('non-literal dynamic import');
    }
    if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === 'require') {
      uses.add('CommonJS require');
    }
    if (!isElementAccessExpression(node)) return;
    if (isIdentifier(node.expression) && ['globalThis', 'self'].includes(node.expression.text)) {
      uses.add('computed global access');
      return;
    }
    const property = staticStringValue(node.argumentExpression);
    if (property !== null && forbiddenWorkerGlobals.has(property)) {
      uses.add(`computed forbidden global ${property}`);
    }
  });
  return [...uses].sort();
}

describe('architecture boundary', () => {
  it('requires every package directory to declare its internal, runtime, and resource dependency policy', async () => {
    const packageDirectories = (await readdir(packageRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(packageDirectories).toEqual(Object.keys(allowedDependencies).sort());
    expect(packageDirectories).toEqual(Object.keys(allowedRuntimeDependencies).sort());
    expect(packageDirectories).toEqual(Object.keys(allowedExternalResources).sort());
  });

  it('keeps relative package dependencies inside their declared boundaries', async () => {
    const files = await sourceFiles(packageRoot);
    const violations: string[] = [];
    for (const file of files) {
      const source = sourceFile(file);
      for (const specifier of importSpecifiers(source)) {
        const violation = relativeDependencyViolation(file, specifier);
        if (violation) violations.push(`${path.relative('.', file)}: ${violation}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('rejects unregistered package-relative imports outside packages', () => {
    const file = path.join(packageRoot, 'control', 'src', 'escape.ts');
    expect(relativeDependencyViolation(file, '../../../action/src/index.js'))
      .toBe('control relative import ../../../action/src/index.js resolves outside packages');
  });

  it('allows only declared external dependencies in package runtime source', async () => {
    const violations: string[] = [];
    for (const sourcePackage of Object.keys(allowedRuntimeDependencies)) {
      for (const file of await sourceFiles(path.join(packageRoot, sourcePackage, 'src'))) {
        const source = sourceFile(file);
        for (const specifier of importSpecifiers(source)) {
          const dependency = runtimeDependencyName(specifier);
          if (dependency && !allowedRuntimeDependencies[sourcePackage]?.has(dependency)) {
            violations.push(`${path.relative('.', file)}: ${sourcePackage} must not import runtime dependency ${dependency}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('allows the Action to depend on Control and its lower-level packages only', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(path.resolve('action/src'))) {
      const source = sourceFile(file);
      for (const specifier of importSpecifiers(source)) {
        const targetPackage = importedPackage(file, specifier);
        if (targetPackage && !['control', 'core', 'github', 'manifest'].includes(targetPackage)) {
          violations.push(`${path.relative('.', file)}: action must not import ${targetPackage}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('recognizes every supported module-loading form without reading comments', () => {
    expect(importSpecifiers(fixtureSourceFile([
      "import type { A } from '../manifest/src/types.js';",
      "import './register.js';",
      "export { helper } from '../core/src/index.js';",
      "const module = await import('../github/src/index.js');",
      "const templateModule = await import(`../github/src/index.js`);",
      "type Imported = import('../core/src/types.js').Imported;",
      "import legacy = require('../relay/src/index.js');",
      "const commonJs = require('../cli/src/index.js');",
      "// import '../ignored/src/index.js';",
    ].join('\n')))).toEqual([
      '../manifest/src/types.js',
      './register.js',
      '../core/src/index.js',
      '../github/src/index.js',
      '../github/src/index.js',
      '../core/src/types.js',
      '../relay/src/index.js',
      '../cli/src/index.js',
    ]);
  });

  it('recognizes Worker runtime violations without reading comments or strings', () => {
    expect(workerRuntimeUses(fixtureSourceFile([
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
    ].join('\n')))).toEqual([
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
    expect(workerRuntimeUses(fixtureSourceFile([
      '// Buffer process fetch NodeJS',
      "const documentation = 'node:crypto @actions/core';",
      "const propertyNames = ['fetch', 'process'];",
    ].join('\n')))).toEqual([]);
  });

  it('continues AST analysis after regular expressions and template substitutions', () => {
    const source = fixtureSourceFile([
      'const pattern = /Buffer|fetch/;',
      "const template = `prefix ${/}/.test(value) ? 'yes' : 'no'} suffix`;",
      "import 'node:crypto';",
      'void process.env.NODE_ENV;',
      'void Buffer.from(value);',
      "void globalThis['fetch'](url);",
    ].join('\n'));
    expect(importSpecifiers(source)).toEqual(['node:crypto']);
    expect(workerRuntimeUses(source)).toEqual([
      'Node built-in module node:crypto',
      'computed global access',
      'forbidden global Buffer',
      'forbidden global process',
    ]);
  });

  it('keeps Worker runtime packages portable and caller-supplied', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(packageRoot)) {
      const sourcePackage = packageName(file);
      if (!sourcePackage || !workerPortablePackages.has(sourcePackage)) continue;
      const source = sourceFile(file);
      for (const use of workerRuntimeUses(source, { allowFetch: sourcePackage === 'github' })) {
        violations.push(`${path.relative('.', file)}: ${use}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
