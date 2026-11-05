import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { CopilotClient } from '@github/copilot-sdk';
import { isolatedCopilotEnvironment, isolatedCopilotClientOptions, isolatedCopilotSessionOptions } from './isolation.mjs';

test('the SDK child receives explicit isolation, no ambient credentials, and no auto-update', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-options-'));
  let invocation;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    invocation = { command, args, options };
    throw new Error('OFFLINE_RUNTIME_STOP');
  });
  syncBuiltinESMExports();
  const options = isolatedCopilotClientOptions(directory, 'fixture-model', {
    ...process.env, STEWARD_APP_PRIVATE_KEY: 'sentinel-private', GH_TOKEN: 'sentinel-github',
    POLICY_READ_TOKEN: 'sentinel-policy', COPILOT_GITHUB_TOKEN: 'sentinel-ambient-model',
    NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'https://sentinel.invalid', COPILOT_CLI_PATH: '/sentinel/runtime',
  });
  const client = new CopilotClient(options);
  try {
    await assert.rejects(client.start(), /OFFLINE_RUNTIME_STOP/);
    assert.ok(invocation);
    assert.ok(invocation.args.includes('--no-auto-update'));
    assert.ok(invocation.args.includes('--no-auto-login'));
    assert.ok(invocation.args.includes('--stdio'));
    assert.equal(invocation.options.cwd, directory);
    assert.equal(invocation.options.env.COPILOT_SDK_AUTH_TOKEN, 'fixture-model');
    assert.equal(invocation.options.env.COPILOT_HOME, directory);
    assert.equal(invocation.options.env.COPILOT_DISABLE_KEYTAR, '1');
    assert.ok(!Object.values(invocation.options.env).some(value => String(value).includes('sentinel')));
    assert.ok(!invocation.args.includes('fixture-model'));
  } finally {
    await client.stop();
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an actual offline process sees only the permitted OS and TLS environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-environment-'));
  try {
    const script = join(directory, 'probe.mjs');
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.env));');
    const environment = isolatedCopilotEnvironment({ ...process.env, GH_TOKEN: 'sentinel-token',
      STEWARD_APP_PRIVATE_KEY: 'sentinel-private', COPILOT_GITHUB_TOKEN: 'sentinel-model',
      NODE_OPTIONS: '--inspect', HTTP_PROXY: 'sentinel-proxy', SSL_CERT_FILE: 'fixture-ca' }, directory);
    const { stdout } = await promisify(childProcess.execFile)(process.execPath, [script], { env: environment });
    const received = JSON.parse(stdout);
    assert.equal(received.SSL_CERT_FILE, 'fixture-ca');
    assert.equal(received.HOME, directory);
    assert.ok(!Object.values(received).some(value => String(value).includes('sentinel')));
    assert.deepEqual(Object.keys(received).filter(key => /TOKEN|SECRET|PRIVATE_KEY/.test(key)), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('each session disables discovery, persistence features and tools and rejects permission requests', () => {
  const options = isolatedCopilotSessionOptions(tmpdir(), 'fixture system message');
  assert.deepEqual(options.availableTools, []);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.customAgents, []);
  assert.deepEqual(options.instructionDirectories, []);
  assert.equal(options.enableConfigDiscovery, false);
  assert.deepEqual(options.memory, { enabled: false });
  assert.deepEqual(options.infiniteSessions, { enabled: false });
  assert.deepEqual(options.onPermissionRequest(), { kind: 'reject' });
  assert.deepEqual(options.systemMessage, { mode: 'append', content: 'fixture system message' });
  assert.ok(!Object.hasOwn(options, 'model'));
  options.availableTools.push('untrusted');
  assert.deepEqual(isolatedCopilotSessionOptions(tmpdir(), 'next').availableTools, []);
});

test('invalid directory and credentials fail before SDK startup', () => {
  assert.throws(() => isolatedCopilotClientOptions('relative', 'fixture'), /DIRECTORY/);
  for (const token of ['', ' ', 'token\nother', 'token\0other']) {
    assert.throws(() => isolatedCopilotClientOptions(tmpdir(), token), /CREDENTIAL_REQUIRED/);
  }
});
