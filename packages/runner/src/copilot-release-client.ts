import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedBuildEnvironment } from './build-environment.js';

/** SDK is a separate fixed entrypoint; App and repository credentials never enter its environment. */
export function copilotReleaseClient(controllerDirectory: string, token: string) {
  const script = resolve(controllerDirectory, 'tools/quality-language/release-notes.mjs');
  const invoke = async (mode: 'preflight' | 'generate', input: string) => {
    if (!token.trim() || /[\r\n\0]/.test(token)) throw new Error('WAIT_AUTH');
    const directory = await mkdtemp(join(tmpdir(), 'steward-content-client-'));
    try {
      const child = spawn(process.execPath, [script, mode], { cwd: directory, windowsHide: true, timeout: 210_000,
        env: { ...isolatedBuildEnvironment(process.env, directory), STEWARD_COPILOT_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.resume(); child.stdin.on('error', () => {});
      const bytes: Buffer[] = []; let size = 0;
      child.stdout.on('data', (part: Buffer) => { size += part.length; if (size > 32 * 1024) child.kill(); else bytes.push(part); });
      const code = await new Promise<number | null>((done, reject) => { child.once('error', () => reject(new Error('RESPONSE_UNKNOWN'))); child.once('close', done); child.stdin.end(input); });
      if (size > 32 * 1024) throw new Error('CONTENT_OUTPUT_LIMIT');
      let result; try { result = JSON.parse(Buffer.concat(bytes).toString('utf8')); } catch { throw new Error('RESPONSE_UNKNOWN'); }
      if (code !== 0 || result.status === 'FAILED') throw new Error(/^(CONTENT_[A-Z_]+|RESPONSE_UNKNOWN)$/.test(result.errorCode) ? result.errorCode : 'RESPONSE_UNKNOWN');
      return result;
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
  return {
    async preflight(): Promise<'READY' | 'WAIT_AUTH' | 'WAIT_QUOTA'> {
      const result = await invoke('preflight', '');
      if (!['READY', 'WAIT_AUTH', 'WAIT_QUOTA'].includes(result.status)) throw new Error('RESPONSE_UNKNOWN'); return result.status;
    },
    async call(input: string): Promise<{ text: string; model: string; usage: { inputTokens: number; outputTokens: number } | null }> {
      const result = await invoke('generate', input);
      if (result.status === 'WAIT_AUTH' || result.status === 'WAIT_QUOTA') throw Object.assign(new Error(result.status), { retryAfterMs: result.retryAfterMs });
      if (result.status !== 'RETURNED' || typeof result.text !== 'string' || typeof result.model !== 'string') throw new Error('RESPONSE_UNKNOWN');
      return { text: result.text, model: result.model, usage: result.usage };
    },
  };
}
