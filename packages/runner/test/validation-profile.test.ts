import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

it('selects new repository profiles from the trusted catalog without editing the entry workflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trusted-profile-'));
  try {
    await writeFile(join(dir, 'repositories.json'), JSON.stringify({
      repositories: { '7123': { managed: true, validationProfile: 'new-product' }, '7124': { managed: false, validationProfile: 'disabled' } },
      defaults: { public: { managed: true, validationProfile: 'public-basic' } },
    }));
    vi.stubEnv('STEWARD_CONFIG_DIRECTORY', dir);
    vi.stubEnv('GITHUB_OUTPUT', join(dir, 'output'));
    await main(['validation-profile', '--repository-id', '7123', '--private', 'true']);
    await main(['validation-profile', '--repository-id', '9999', '--private', 'false']);
    expect(await readFile(join(dir, 'output'), 'utf8')).toBe('name=new-product\nname=public-basic\n');
    await expect(main(['validation-profile', '--repository-id', '9999', '--private', 'true'])).rejects.toThrow('没有启用');
    await expect(main(['validation-profile', '--repository-id', '7124', '--private', 'false'])).rejects.toThrow('没有启用');
    await expect(main(['validation-profile', '--repository-id', '7123', '--private', 'unknown'])).rejects.toThrow('可见性无效');
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true });
  }
});
