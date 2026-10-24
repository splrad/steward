import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { request } from 'node:https';

it('rejects an unregistered HTTP request before transport', () => {
  expect(() => fetch('https://example.invalid/unregistered')).toThrow('TEST_NETWORK_DENIED');
  expect(() => request('https://example.invalid/unregistered')).toThrow('TEST_NETWORK_DENIED');
});
it('rejects model executables and shell wrappers before subprocess creation', () => {
  for (const [command, args] of [
    ['copilot', ['--prompt', 'test']],
    [process.execPath, ['node_modules/@github/copilot/index.js']],
    ['pwsh', ['-Command', 'copilot']],
    ['bash', ['-c', 'copilot']],
  ] as [string, string[]][]) {
    expect(() => spawnSync(command, args)).toThrow('TEST_SUBPROCESS_DENIED');
  }
});

it('rejects direct TCP, TLS and UDP transports while preserving pure IP parsing', async () => {
  const net = await import('node:net'); const tls = await import('node:tls'); const udp = await import('node:dgram');
  expect(net.isIP('127.0.0.1')).toBe(4);
  for (const attempt of [
    () => net.connect(443, 'example.invalid'), () => net.createConnection(443, 'example.invalid'),
    () => new net.Socket().connect(443, 'example.invalid'),
    () => tls.connect(443, 'example.invalid'), () => new tls.TLSSocket(new net.Socket()).connect(443, 'example.invalid'),
    () => udp.createSocket('udp4'),
  ]) expect(attempt).toThrow('TEST_NETWORK_DENIED');
});
