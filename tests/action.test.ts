import { describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core', () => ({
  getInput: vi.fn(() => 'version'),
  info: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
}));

const { run, STEWARD_VERSION } = await import('../action/src/main.js');

describe('Steward Action bootstrap', () => {
  it('reports its bundled version', async () => {
    const core = await import('@actions/core');
    await run({ operation: 'version' });
    expect(core.setOutput).toHaveBeenCalledWith('steward-version', STEWARD_VERSION);
  });

  it('rejects operations that are not implemented', async () => {
    await expect(run({ operation: 'governance' })).rejects.toThrow('Unsupported Steward operation: governance');
  });

  it('requires a separate mutation token before a human review operation loads context', async () => {
    await expect(run({ operation: 'governance-request-copilot', token: 'platform-token' }))
      .rejects.toThrow('requires an explicit mutation token');
  });
});
