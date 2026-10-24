import { afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { resetOfflineFixtures } from './offline-fixtures.js';

for (const name of Object.keys(process.env)) {
  if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY)/i.test(name)) delete process.env[name];
}
// Preserve only the installed tool directory before hiding the real home and credentials.
// mise-action uses the default data directory unless explicitly overridden.
process.env.MISE_DATA_DIR ??= process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'mise') : process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'mise')
  : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'mise');
if (existsSync(process.env.MISE_DATA_DIR)) process.env.MISE_DATA_DIR = realpathSync(process.env.MISE_DATA_DIR);
const isolatedHome = mkdtempSync(join(tmpdir(), 'steward-test-home-'));
for (const name of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE', 'AZURE_CONFIG_DIR', 'CLOUDSDK_CONFIG', 'COPILOT_HOME']) {
  process.env[name] = isolatedHome;
}
afterAll(() => rmSync(isolatedHome, { recursive: true, force: true }));
resetOfflineFixtures();
afterAll(resetOfflineFixtures);

// Unregistered requests fail before any production transport is reached.
// Individual tests supply their own fetch/http mocks for registered fixtures.
const rejectNetwork = () => { throw new Error('TEST_NETWORK_DENIED: register an explicit transport mock'); };
vi.stubGlobal('fetch', rejectNetwork);
beforeEach(() => { vi.stubGlobal('fetch', rejectNetwork); });

vi.mock('node:http', async importOriginal => {
  const original = await importOriginal<typeof import('node:http')>();
  const deny = () => { throw new Error('TEST_NETWORK_DENIED: http'); };
  return { ...original, request: deny, get: deny, default: { ...original, request: deny, get: deny } };
});
vi.mock('node:https', async importOriginal => {
  const original = await importOriginal<typeof import('node:https')>();
  const deny = () => { throw new Error('TEST_NETWORK_DENIED: https'); };
  return { ...original, request: deny, get: deny, default: { ...original, request: deny, get: deny } };
});

// Preserve address parsing and other pure helpers, but deny every socket constructor path.
vi.mock('node:net', async importOriginal => {
  const original = await importOriginal<typeof import('node:net')>();
  const deny = () => { throw new Error('TEST_NETWORK_DENIED: net'); };
  class Socket extends original.Socket { override connect(..._args: any[]): this { return deny(); } }
  const guarded = { ...original, Socket, connect: deny, createConnection: deny, createServer: deny };
  return { ...guarded, default: guarded };
});
vi.mock('node:tls', async importOriginal => {
  const original = await importOriginal<typeof import('node:tls')>();
  const deny = () => { throw new Error('TEST_NETWORK_DENIED: tls'); };
  class TLSSocket extends original.TLSSocket { override connect(..._args: any[]): this { return deny(); } }
  const guarded = { ...original, TLSSocket, connect: deny, createServer: deny };
  return { ...guarded, default: guarded };
});
vi.mock('node:dgram', async importOriginal => {
  const original = await importOriginal<typeof import('node:dgram')>();
  const deny = () => { throw new Error('TEST_NETWORK_DENIED: dgram'); };
  const guarded = { ...original, createSocket: deny };
  return { ...guarded, default: guarded };
});

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { offlineProcessArguments } = await import('./offline-fixtures.js');
  const { promisify } = await import('node:util');
  const wrap = (fn: (...args: any[]) => any) => (...args: any[]) => {
    const command = String(args[0]);
    const argv = Array.isArray(args[1]) ? args[1].map(String) : [];
    const permitted = offlineProcessArguments(command, argv, args[2]);
    if (!permitted) {
      throw new Error(`TEST_SUBPROCESS_DENIED: ${command} requires an audited offline fixture (${argv[0] ?? 'no arguments'})`);
    }
    args[1] = permitted;
    return fn(...args);
  };
  const guarded = {
    ...original,
    spawn: wrap(original.spawn), spawnSync: wrap(original.spawnSync),
    execFile: wrap(original.execFile), execFileSync: wrap(original.execFileSync),
    exec: wrap(original.exec), execSync: wrap(original.execSync), fork: wrap(original.fork),
  };
  (guarded.execFile as any)[promisify.custom] = wrap((original.execFile as any)[promisify.custom]);
  return { ...guarded, default: guarded };
});
