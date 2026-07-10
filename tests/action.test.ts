import { describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core', () => ({
  getInput: vi.fn(() => 'version'),
  info: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
}));

const { run, STEWARD_VERSION } = await import('../action/src/main.js');

describe('Steward Action bootstrap', () => {
  it('reports its bundled version', async () => {
    const core = await import('@actions/core');
    run('version');
    expect(core.setOutput).toHaveBeenCalledWith('steward-version', STEWARD_VERSION);
  });

  it('rejects operations that are not implemented', () => {
    expect(() => run('governance')).toThrow('Unsupported Steward operation: governance');
  });
});
