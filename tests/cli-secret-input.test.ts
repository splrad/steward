import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  redactSensitiveText,
  requiredSecretRequirements,
  SecretInputCancelledError,
  SecretInputEofError,
  TerminalSecretPrompt,
  withRequiredSecrets,
  type SecretPrompt,
  type SecretRequirement,
} from '../packages/cli/src/secret-input.js';
import type { StewardManifest } from '../packages/manifest/src/index.js';

function manifest(features: Partial<StewardManifest['features']> = {}): StewardManifest {
  return {
    schemaVersion: 1,
    automation: {
      githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
      maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
      language: 'zh-CN',
    },
    features: {
      prAutomation: false,
      classification: false,
      dcoAdvisory: false,
      governance: false,
      copilotReview: false,
      release: false,
      webhookRelay: false,
      ...features,
    },
  };
}

function rsaPrivateKey(): Buffer {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }));
}

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  readonly rawModes: boolean[] = [];

  isPaused(): boolean { return this.paused; }
  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    this.isRaw = mode;
    return this;
  }
  resume(): this { this.paused = false; return this; }
  pause(): this { this.paused = true; return this; }
}

class FakeOutput {
  isTTY = true;
  readonly writes: string[] = [];
  write(value: string): boolean { this.writes.push(value); return true; }
}

class ScriptedPrompt implements SecretPrompt {
  readonly returned: Buffer[] = [];
  #values: Buffer[];

  constructor(values: Buffer[]) {
    this.#values = values;
  }

  async readSecret(): Promise<Buffer> {
    const value = this.#values.shift();
    if (!value) throw new Error('No scripted Secret remains');
    this.returned.push(value);
    return value;
  }
}

const tokenRequirement: SecretRequirement = {
  name: 'COPILOT_REVIEW_REQUEST_TOKEN',
  mode: 'single-line',
  maxBytes: 4_096,
};

describe('Secret input and memory lifecycle', () => {
  it('derives the exact Secret contract from enabled features', () => {
    expect(requiredSecretRequirements(manifest())).toEqual([]);
    expect(requiredSecretRequirements(manifest({ classification: true }))).toEqual([
      { name: 'WORKFLOW_AUTOMATION_APP_PRIVATE_KEY', mode: 'multiline', maxBytes: 65_536 },
    ]);
    expect(requiredSecretRequirements(manifest({ governance: true, copilotReview: true })).map((item) => item.name)).toEqual([
      'WORKFLOW_AUTOMATION_APP_PRIVATE_KEY',
      'COPILOT_REVIEW_REQUEST_TOKEN',
      'CORE_AUTO_APPROVAL_TOKEN',
    ]);
  });

  it('reads a single-line token without echo and restores terminal state', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const prompt = new TerminalSecretPrompt(input, output);
    const pending = prompt.readSecret(tokenRequirement);
    input.emit('data', Buffer.from('github_pat_hidden_value_1234567890X\b\r\n'));
    const value = await pending;

    expect(value.toString()).toBe('github_pat_hidden_value_1234567890');
    expect(output.writes.join('')).not.toContain(value.toString());
    expect(output.writes.join('')).toBe('COPILOT_REVIEW_REQUEST_TOKEN (input hidden): \n');
    expect(input.rawModes).toEqual([true, false]);
    expect(input.paused).toBe(true);
    value.fill(0);
  });

  it('reads multiline PEM input until a line containing only a dot', async () => {
    const key = rsaPrivateKey();
    const input = new FakeInput();
    const output = new FakeOutput();
    const prompt = new TerminalSecretPrompt(input, output);
    const requirement: SecretRequirement = {
      name: 'WORKFLOW_AUTOMATION_APP_PRIVATE_KEY', mode: 'multiline', maxBytes: 65_536,
    };
    const pending = prompt.readSecret(requirement);
    input.emit('data', Buffer.concat([key, Buffer.from('.\r\nignored')]));
    const value = await pending;

    expect(value.toString().trimEnd()).toBe(key.toString().trimEnd());
    expect(output.writes.join('')).not.toContain('PRIVATE KEY');
    expect(input.rawModes).toEqual([true, false]);
    key.fill(0);
    value.fill(0);
  });

  it('restores terminal state on cancellation and EOF', async () => {
    const cancelledInput = new FakeInput();
    const cancelled = new TerminalSecretPrompt(cancelledInput, new FakeOutput()).readSecret(tokenRequirement);
    cancelledInput.emit('data', Buffer.from([0x03]));
    await expect(cancelled).rejects.toBeInstanceOf(SecretInputCancelledError);
    expect(cancelledInput.rawModes).toEqual([true, false]);
    expect(cancelledInput.paused).toBe(true);

    const eofInput = new FakeInput();
    const eof = new TerminalSecretPrompt(eofInput, new FakeOutput()).readSecret(tokenRequirement);
    eofInput.emit('end');
    await expect(eof).rejects.toBeInstanceOf(SecretInputEofError);
    expect(eofInput.rawModes).toEqual([true, false]);
    expect(eofInput.paused).toBe(true);
  });

  it('rejects non-interactive sources before reading or rendering', async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    input.isTTY = false;
    await expect(new TerminalSecretPrompt(input, output).readSecret(tokenRequirement))
      .rejects.toThrow('argv, environment, files, and piped stdin are not accepted');
    expect(output.writes).toEqual([]);
    expect(input.rawModes).toEqual([]);
  });

  it('counts multiline separators toward the size limit', async () => {
    const input = new FakeInput();
    const requirement: SecretRequirement = {
      name: 'WORKFLOW_AUTOMATION_APP_PRIVATE_KEY', mode: 'multiline', maxBytes: 3,
    };
    const pending = new TerminalSecretPrompt(input, new FakeOutput()).readSecret(requirement);
    input.emit('data', Buffer.from('\n\n\n\n\n.\n'));
    await expect(pending).rejects.toThrow('exceeds the input size limit');
  });

  it('validates values, redacts exact in-memory Secrets, and zeroes them after use', async () => {
    const key = rsaPrivateKey();
    const copilot = Buffer.from('overlapping-secret-1234567890');
    const approval = Buffer.from('overlapping-secret-1234567890-extra');
    const prompt = new ScriptedPrompt([key, copilot, approval]);
    const heldReferences: Buffer[] = [];

    const result = await withRequiredSecrets(
      manifest({ governance: true, copilotReview: true }),
      prompt,
      async (vault) => {
        expect(vault.names()).toEqual([
          'WORKFLOW_AUTOMATION_APP_PRIVATE_KEY',
          'COPILOT_REVIEW_REQUEST_TOKEN',
          'CORE_AUTO_APPROVAL_TOKEN',
        ]);
        await vault.use('COPILOT_REVIEW_REQUEST_TOKEN', (value) => heldReferences.push(value));
        await vault.use('CORE_AUTO_APPROVAL_TOKEN', (value) => heldReferences.push(value));
        const redacted = vault.redact(`copilot=${copilot.toString()} approval=${approval.toString()}`);
        expect(redacted).toBe(
          'copilot=[REDACTED:COPILOT_REVIEW_REQUEST_TOKEN] approval=[REDACTED:CORE_AUTO_APPROVAL_TOKEN]',
        );
        return 'complete';
      },
    );

    expect(result).toBe('complete');
    expect(prompt.returned.every((value) => value.every((byte) => byte === 0))).toBe(true);
    expect(heldReferences.every((value) => value.every((byte) => byte === 0))).toBe(true);
  });

  it('zeroes both accepted and rejected values when validation fails', async () => {
    const key = rsaPrivateKey();
    const invalid = Buffer.from('short');
    const prompt = new ScriptedPrompt([key, invalid]);

    await expect(withRequiredSecrets(
      manifest({ copilotReview: true }),
      prompt,
      () => undefined,
    )).rejects.toThrow('is too short');
    expect(prompt.returned.every((value) => value.every((byte) => byte === 0))).toBe(true);
  });

  it('rejects malformed keys and non-ASCII tokens without retaining their buffers', async () => {
    const invalidKey = Buffer.from('-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----');
    const keyPrompt = new ScriptedPrompt([invalidKey]);
    await expect(withRequiredSecrets(
      manifest({ classification: true }), keyPrompt, () => undefined,
    )).rejects.toThrow('complete RSA PEM private key');
    expect(invalidKey.every((byte) => byte === 0)).toBe(true);

    const key = rsaPrivateKey();
    const nonAscii = Buffer.concat([Buffer.from('token-value-1234567890'), Buffer.from([0x80])]);
    const tokenPrompt = new ScriptedPrompt([key, nonAscii]);
    await expect(withRequiredSecrets(
      manifest({ copilotReview: true }), tokenPrompt, () => undefined,
    )).rejects.toThrow('printable ASCII');
    expect(tokenPrompt.returned.every((value) => value.every((byte) => byte === 0))).toBe(true);
  });

  it('zeroes all retained values when the scoped consumer fails', async () => {
    const key = rsaPrivateKey();
    const prompt = new ScriptedPrompt([key]);
    await expect(withRequiredSecrets(
      manifest({ classification: true }), prompt, () => { throw new Error('mutation failed'); },
    )).rejects.toThrow('mutation failed');
    expect(key.every((byte) => byte === 0)).toBe(true);
  });

  it('redacts common credential shapes from top-level errors', () => {
    const keyBuffer = rsaPrivateKey();
    const key = keyBuffer.toString();
    keyBuffer.fill(0);
    const text = [
      key,
      'github_pat_FAKE123456789012345678901234567890',
      'ghp_FAKE123456789012345678901234567890',
      'Authorization: Bearer bearer-secret-value',
      'eyJheader1234567890.eyJpayload1234567890.signature1234567890-',
    ].join('\n');
    const redacted = redactSensitiveText(text);

    expect(redacted).not.toContain('PRIVATE KEY');
    expect(redacted).not.toContain('github_pat_');
    expect(redacted).not.toContain('ghp_');
    expect(redacted).not.toContain('bearer-secret-value');
    expect(redacted).not.toContain('eyJheader');
    expect(redactSensitiveText('prefix -----BEGIN PRIVATE KEY-----\\ntruncated'))
      .toBe('prefix [REDACTED:PRIVATE_KEY]');
  });
});
