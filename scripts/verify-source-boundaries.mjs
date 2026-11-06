import { API } from 'typescript/unstable/sync';
import * as ts from 'typescript/unstable/ast';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

// Use the installed compiler's parsed source and resolved module symbols, not a second import resolver.
const root = process.cwd(), api = new API({ cwd: root });
const local = path => relative(root, path).replaceAll('\\', '/');
const diagnostics = [], modules = [];
try {
  const snapshot = api.updateSnapshot({ openProjects: [resolve('tsconfig.json')] });
  const project = snapshot.getProject(resolve('tsconfig.json'));
  if (!project) throw new Error('SOURCE_BOUNDARY: TypeScript project unavailable');
  const { program, checker } = project;
  for (const filename of program.getSourceFileNames()) {
    const path = local(filename);
    if (!/^packages\/(core|runner|github)\/src\/.*\.ts$/.test(path)) continue;
    const source = program.getSourceFile(filename), imports = [], functions = [], initializers = [];
    const problem = (node, reason) => diagnostics.push({ file: path, position: node.pos, reason });
    const dependency = (node, literal) => {
      if (!literal || !ts.isStringLiteral(literal)) { problem(node, 'Unresolved dynamic module specifier'); return; }
      const specifier = literal.text;
      const symbol = checker.getSymbolAtLocation(literal);
      const declaration = symbol?.declarations[0]?.resolve(project);
      const target = declaration ? local(declaration.getSourceFile().fileName) : null;
      imports.push({ specifier, target, position: node.pos });
      if (!target) problem(node, `Unresolved module: ${specifier}`);
      if (path.startsWith('packages/core/')) {
        if (target && /^packages\/(runner|github|runtime)\//.test(target)) problem(node, 'Core imports an execution adapter');
        if (/^(?:node:)?(?:fs|https?|net|tls|dgram|child_process|worker_threads|os)(?:\/|$)/.test(specifier)) problem(node, 'Core imports system I/O');
      }
      if (path.startsWith('packages/github/') && target && /^packages\/(runner|runtime)\//.test(target)) problem(node, 'GitHub adapter imports an execution entry');
      if (target === 'packages/runner/src/index.ts') problem(node, 'Business module imports the CLI entry');
      if (/copilot-sdk|tools\/quality-language/.test(specifier + ' ' + target)) problem(node, 'SDK crosses the isolated process boundary');
      if (path.startsWith('packages/runner/') && /^packages\/(core|github)\/src\/index\.ts$/.test(target ?? '')) problem(node, 'Runner uses a cross-package barrel');
    };
    const visit = node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) dependency(node, node.moduleSpecifier);
      } else if (ts.isImportTypeNode(node)) {
        dependency(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dependency(node, node.arguments[0]);
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) functions.push({ name: node.name?.getText(source) ?? '<anonymous>', position: node.pos });
      if (path.startsWith('packages/core/')) {
        if (ts.isPropertyAccessExpression(node) && /^(?:process\.env|(?:globalThis\.)?Date\.now|Math\.random)$/.test(node.getText(source))) problem(node, 'Core reads ambient state or time');
        if (ts.isCallExpression(node) && /^(?:globalThis\.)?fetch$/.test(node.expression.getText(source))) problem(node, 'Core performs network I/O');
        if (ts.isNewExpression(node) && node.expression.getText(source) === 'Date' && !node.arguments?.length) problem(node, 'Core reads the current clock');
      }
      node.forEachChild(visit);
    };
    visit(source);
    for (const node of source.statements) {
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
        if (declaration.initializer) initializers.push({ name: declaration.name.getText(source), expression: declaration.initializer.getText(source) });
      }
      if (ts.isExpressionStatement(node) || ts.isIfStatement(node)) initializers.push({ expression: node.getText(source) });
    }
    modules.push({ path, imports, functions, initializers });
  }
  const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
  const rootLock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const sdkLock = JSON.parse(readFileSync('tools/quality-language/package-lock.json', 'utf8'));
  if (JSON.stringify(rootPackage.workspaces) !== '["packages/*","services/settings-events"]'
    || Object.keys(rootLock.packages).some(path => path.includes('@github/copilot-sdk'))
    || !sdkLock.packages['node_modules/@github/copilot-sdk']) diagnostics.push({ file: 'package.json', reason: 'SDK installation boundary changed' });
  const report = { compilerVersion: JSON.parse(readFileSync('node_modules/typescript/package.json', 'utf8')).version,
    modules, diagnostics, scope: 'Parsed source imports/exports, compiler module resolution, core ambient I/O references, SDK lock boundary. Initializers are recorded for review; this is not runtime acceptance.' };
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  if (diagnostics.length) throw new Error('SOURCE_BOUNDARY: ' + JSON.stringify(diagnostics));
  console.log(`Source boundaries: ${modules.length} modules, ${modules.reduce((total, module) => total + module.imports.length, 0)} resolved imports/exports; no violations.`);
} finally { api.close(); }
