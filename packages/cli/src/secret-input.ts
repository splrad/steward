import { createPrivateKey } from 'node:crypto';
import type { StewardManifest } from '../../manifest/src/index.js';

export type StewardSecretName = 'WORKFLOW_AUTOMATION_APP_PRIVATE_KEY'
  | 'COPILOT_REVIEW_REQUEST_TOKEN'
  | 'CORE_AUTO_APPROVAL_TOKEN';

export interface SecretRequirement {
  name: StewardSecretName;
  mode: 'single-line' | 'multiline';
  maxBytes: number;
}

export interface SecretPrompt {
  readSecret(requirement: SecretRequirement): Promise<Buffer>;
}

interface TtyInput {
  isTTY?: boolean;
  isRaw?: boolean;
  isPaused(): boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  once(event: 'end', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'end', listener: () => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

interface TtyOutput {
  isTTY?: boolean;
  write(value: string): unknown;
}

export class SecretInputCancelledError extends Error {
  constructor() {
    super('Secret input cancelled');
    this.name = 'SecretInputCancelledError';
  }
}

export class SecretInputEofError extends Error {
  constructor() {
    super('Secret input ended before completion');
    this.name = 'SecretInputEofError';
  }
}

export function requiredSecretRequirements(manifest: StewardManifest): SecretRequirement[] {
  const requirements: SecretRequirement[] = [];
  if (manifest.features.prAutomation || manifest.features.classification || manifest.features.dcoAdvisory
    || manifest.features.governance || manifest.features.copilotReview || manifest.features.release) {
    requirements.push({ name: 'WORKFLOW_AUTOMATION_APP_PRIVATE_KEY', mode: 'multiline', maxBytes: 65_536 });
  }
  if (manifest.features.copilotReview) {
    requirements.push({ name: 'COPILOT_REVIEW_REQUEST_TOKEN', mode: 'single-line', maxBytes: 4_096 });
  }
  if (manifest.features.governance) {
    requirements.push({ name: 'CORE_AUTO_APPROVAL_TOKEN', mode: 'single-line', maxBytes: 4_096 });
  }
  return requirements;
}

export function requiredSecretNames(manifest: StewardManifest): string[] {
  return requiredSecretRequirements(manifest).map((requirement) => requirement.name).sort();
}

function removeLastCodePoint(line: number[]): number {
  const originalLength = line.length;
  let byte = line.pop();
  while (byte !== undefined && (byte & 0xc0) === 0x80) byte = line.pop();
  return originalLength - line.length;
}

function validateSecret(requirement: SecretRequirement, value: Buffer): void {
  if (!value.length) throw new Error(`${requirement.name} must not be empty`);
  if (value.length > requirement.maxBytes) throw new Error(`${requirement.name} exceeds the input size limit`);
  if (value.includes(0)) throw new Error(`${requirement.name} contains a NUL byte`);
  if (requirement.mode === 'single-line') {
    if (value.length < 20) throw new Error(`${requirement.name} is too short`);
    for (const byte of value) {
      if (byte < 0x21 || byte > 0x7e) {
        throw new Error(`${requirement.name} must contain printable ASCII without whitespace`);
      }
    }
    return;
  }
  try {
    const key = createPrivateKey({ key: value, format: 'pem' });
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
  } catch {
    throw new Error(`${requirement.name} must be a complete RSA PEM private key`);
  }
}

export class TerminalSecretPrompt implements SecretPrompt {
  readonly #input: TtyInput;
  readonly #output: TtyOutput;
  #active = false;

  constructor(input: TtyInput = process.stdin as TtyInput, output: TtyOutput = process.stderr as TtyOutput) {
    this.#input = input;
    this.#output = output;
  }

  async readSecret(requirement: SecretRequirement): Promise<Buffer> {
    if (this.#active) throw new Error('Another Secret input is already active');
    if (!this.#input.isTTY || !this.#output.isTTY) {
      throw new Error('Secret input requires an interactive TTY; argv, environment, files, and piped stdin are not accepted');
    }
    this.#active = true;
    try {
      return await this.#readRaw(requirement);
    } finally {
      this.#active = false;
    }
  }

  async #readRaw(requirement: SecretRequirement): Promise<Buffer> {
    const input = this.#input;
    const output = this.#output;
    const originalRaw = input.isRaw === true;
    const originallyPaused = input.isPaused();
    const lines: number[][] = [];
    let line: number[] = [];
    let totalBytes = 0;
    let previousWasCr = false;
    let settled = false;
    const prompt = requirement.mode === 'multiline'
      ? `${requirement.name} (input hidden; finish with a line containing only .): `
      : `${requirement.name} (input hidden): `;
    output.write(prompt);

    return new Promise<Buffer>((resolve, reject) => {
      const zeroWorkingMemory = () => {
        line.fill(0);
        for (const item of lines) item.fill(0);
      };
      const cleanup = () => {
        input.off('data', onData);
        input.off('end', onEnd);
        input.off('error', onError);
        try { input.setRawMode(originalRaw); } catch { /* Best effort after the primary result is fixed. */ }
        if (originallyPaused) input.pause();
        try { output.write('\n'); } catch { /* Do not replace the primary result with a rendering failure. */ }
      };
      const finish = (error?: Error, value?: Buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        zeroWorkingMemory();
        if (error) reject(error);
        else resolve(value ?? Buffer.alloc(0));
      };
      const completeLine = () => {
        if (requirement.mode === 'single-line') {
          const value = Buffer.from(line);
          finish(undefined, value);
          return;
        }
        if (line.length === 1 && line[0] === 0x2e) {
          const content = lines.flatMap((item, index) => (index ? [0x0a, ...item] : item));
          const value = Buffer.from(content);
          content.fill(0);
          finish(undefined, value);
          return;
        }
        if (lines.length > 0) {
          totalBytes += 1;
          if (totalBytes > requirement.maxBytes) {
            finish(new Error(`${requirement.name} exceeds the input size limit`));
            return;
          }
        }
        lines.push(line);
        line = [];
      };
      const onData = (chunk: Buffer | string) => {
        if (typeof chunk === 'string') {
          finish(new Error('Secret TTY input must remain in binary mode'));
          return;
        }
        for (const byte of chunk) {
          if (settled) break;
          if (previousWasCr && byte === 0x0a) {
            previousWasCr = false;
            continue;
          }
          previousWasCr = false;
          if (byte === 0x03) {
            finish(new SecretInputCancelledError());
          } else if (byte === 0x04 || byte === 0x1a) {
            finish(new SecretInputEofError());
          } else if (byte === 0x08 || byte === 0x7f) {
            totalBytes -= removeLastCodePoint(line);
          } else if (byte === 0x0d || byte === 0x0a) {
            previousWasCr = byte === 0x0d;
            completeLine();
          } else if (byte < 0x20) {
            finish(new Error(`${requirement.name} contains an unsupported control character`));
          } else {
            line.push(byte);
            totalBytes += 1;
            if (totalBytes > requirement.maxBytes) {
              finish(new Error(`${requirement.name} exceeds the input size limit`));
            }
          }
        }
      };
      const onEnd = () => finish(new SecretInputEofError());
      const onError = () => finish(new Error('Secret input failed'));

      try {
        input.setRawMode(true);
        input.on('data', onData);
        input.once('end', onEnd);
        input.once('error', onError);
        input.resume();
      } catch {
        finish(new Error('Unable to enter hidden TTY input mode'));
      }
    });
  }
}

function replaceBytes(input: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  if (!needle.length) return input;
  const parts: Buffer[] = [];
  let cursor = 0;
  let index = input.indexOf(needle, cursor);
  if (index < 0) return input;
  while (index >= 0) {
    parts.push(input.subarray(cursor, index), replacement);
    cursor = index + needle.length;
    index = input.indexOf(needle, cursor);
  }
  parts.push(input.subarray(cursor));
  return Buffer.concat(parts);
}

function staticRedaction(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[REDACTED:PRIVATE_KEY]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:GITHUB_TOKEN]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:GITHUB_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?=$|[^A-Za-z0-9_-])/g, '[REDACTED:JWT]')
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s,;]+/gi, '$1[REDACTED]');
}

export class SecretVault {
  readonly #values: Map<StewardSecretName, Buffer>;
  #disposed = false;

  constructor(values: Map<StewardSecretName, Buffer>) {
    this.#values = values;
  }

  names(): StewardSecretName[] {
    if (this.#disposed) throw new Error('Secret vault is disposed');
    return [...this.#values.keys()];
  }

  async use<T>(name: StewardSecretName, consumer: (value: Buffer) => T | Promise<T>): Promise<T> {
    if (this.#disposed) throw new Error('Secret vault is disposed');
    const value = this.#values.get(name);
    if (!value) throw new Error(`Secret ${name} is unavailable`);
    return consumer(value);
  }

  redact(text: string): string {
    if (this.#disposed) return staticRedaction(text);
    let bytes: Buffer<ArrayBufferLike> = Buffer.from(text, 'utf8');
    try {
      const valuesByDescendingLength = Array.from(this.#values).sort((left, right) => right[1].length - left[1].length);
      for (const [name, secret] of valuesByDescendingLength) {
        const replacement = Buffer.from(`[REDACTED:${name}]`, 'utf8');
        const next = replaceBytes(bytes, secret, replacement);
        replacement.fill(0);
        if (next !== bytes) bytes.fill(0);
        bytes = next;
      }
      return staticRedaction(bytes.toString('utf8'));
    } finally {
      bytes.fill(0);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const value of this.#values.values()) value.fill(0);
    this.#values.clear();
    this.#disposed = true;
  }
}

export function redactSensitiveText(value: string): string {
  return staticRedaction(value);
}

export async function withRequiredSecrets<T>(
  manifest: StewardManifest,
  prompt: SecretPrompt,
  consumer: (vault: SecretVault) => T | Promise<T>,
): Promise<T> {
  return withSecrets(requiredSecretRequirements(manifest), prompt, consumer);
}

export async function withSecrets<T>(
  requirements: readonly SecretRequirement[],
  prompt: SecretPrompt,
  consumer: (vault: SecretVault) => T | Promise<T>,
): Promise<T> {
  const values = new Map<StewardSecretName, Buffer>();
  let vault: SecretVault | undefined;
  try {
    for (const requirement of requirements) {
      if (values.has(requirement.name)) throw new Error(`Duplicate Secret requirement: ${requirement.name}`);
      const value = await prompt.readSecret(requirement);
      try {
        validateSecret(requirement, value);
      } catch (error) {
        value.fill(0);
        throw error;
      }
      values.set(requirement.name, value);
    }
    vault = new SecretVault(values);
    return await consumer(vault);
  } finally {
    if (vault) vault.dispose();
    else {
      for (const value of values.values()) value.fill(0);
      values.clear();
    }
  }
}
