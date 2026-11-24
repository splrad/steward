import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const env = process.env;
const args = process.argv.slice(2);
const reportDir = env.STEWARD_NODE_TEST_REPORTS;

function run(command, argv, options = env) {
  const result = spawnSync(command, argv, { env: options, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function test(name, argv) {
  if (!reportDir) return run(process.execPath, [env.npm_execpath, ...argv]);
  mkdirSync(reportDir, { recursive: true });
  const file = resolve(reportDir, name + '.xml').replaceAll('\\', '/');
  const reporters = `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="${file}"`;
  run(process.execPath, [env.npm_execpath, ...argv], {
    ...env, NODE_OPTIONS: [env.NODE_OPTIONS, reporters].filter(Boolean).join(' '),
  });
}

if (args[0] === '--controller-only') {
  test('controller-source', ['run', 'test:controller-source']);
} else if (args[0] === '--quality-language') {
  test('quality-language', ['test', '--prefix', 'tools/quality-language']);
} else {
  run('uv', ['sync', '--project', 'tools/template', '--frozen', '--only-group', 'release-inspection', '--inexact', '--no-build']);
  for (const name of ['pages', 'private-dependencies', 'settings-events', 'controller-source', 'bounded-release', 'configuration']) {
    test(name, ['run', 'test:' + name]);
  }
  run(process.execPath, [env.npm_execpath, 'exec', '--offline', '--', 'vitest', 'run', ...args]);
}
