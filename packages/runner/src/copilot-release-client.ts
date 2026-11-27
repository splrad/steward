import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedBuildEnvironment } from './build-environment.js';

/** SDK is a separate fixed entrypoint; App and repository credentials never enter its environment. */
export function copilotReleaseClient(controllerDirectory: string, token: string, purpose: 'generate' | 'classify' = 'generate') {
  const script = resolve(controllerDirectory, 'tools/quality-language/release-notes.mjs');
  const invoke = async (mode: 'preflight' | 'generate' | 'maintained' | 'classify', input: string) => {
    if (!token.trim() || /[\r\n\0]/.test(token)) throw new Error('WAIT_AUTH');
    const directory = await mkdtemp(join(tmpdir(), 'steward-content-client-'));
    try {
      const child = spawn(process.execPath, [script, mode], { cwd: directory, windowsHide: true, timeout: mode === 'maintained' ? 420_000 : 210_000,
        env: { ...isolatedBuildEnvironment(process.env, directory), STEWARD_COPILOT_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.resume(); child.stdin.on('error', () => {});
      const bytes: Buffer[] = []; let size = 0;
      child.stdout.on('data', (part: Buffer) => { size += part.length; if (size > 32 * 1024) child.kill(); else bytes.push(part); });
      const processFailure = () => Object.assign(new Error('RESPONSE_UNKNOWN'), { sdkStage: 'process' });
      const code = await new Promise<number | null>((done, reject) => { child.once('error', () => reject(processFailure())); child.once('close', done); child.stdin.end(input); });
      if (size > 32 * 1024) throw new Error('CONTENT_OUTPUT_LIMIT');
      let result; try { result = JSON.parse(Buffer.concat(bytes).toString('utf8')); } catch { throw processFailure(); }
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.status !== 'string') throw processFailure();
      const diagnostic = { sdkStage: result.diagnostic?.sdkStage, sdkErrorType: result.diagnostic?.sdkErrorType,
        status: result.diagnostic?.status };
      if (code !== 0 || result.status === 'FAILED') {
        const errorCode = /^(CONTENT_[A-Z_]+|RESPONSE_UNKNOWN)$/.test(result.errorCode) ? result.errorCode : 'RESPONSE_UNKNOWN';
        throw Object.assign(new Error(errorCode), diagnostic);
      }
      if (result.status === 'WAIT_AUTH' || result.status === 'WAIT_QUOTA') {
        if (mode === 'preflight') return result;
        throw Object.assign(new Error(result.status), diagnostic, { retryAfterMs: result.retryAfterMs });
      }
      if (mode === 'preflight' ? result.status !== 'READY' :
        result.status !== 'RETURNED' || typeof result.text !== 'string' || typeof result.model !== 'string') throw processFailure();
      return result;
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
  return {
    async preflight(): Promise<'READY' | 'WAIT_AUTH' | 'WAIT_QUOTA'> {
      const result = await invoke('preflight', '');
      return result.status;
    },
    async call(input: string, allowLongContext = false): Promise<{ text: string; model: string; usage: object | null }> {
      const mode = purpose === 'generate' && allowLongContext ? 'maintained' : purpose;
      const result = await invoke(mode, input);
      if (mode === 'maintained' && result.contextTier === 'long_context') {
        console.info(JSON.stringify({ event: 'candidate_long_context', contextTier: result.contextTier }));
      }
      return { text: result.text, model: result.model, usage: result.usage };
    },
  };
}
