import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseAdoptionProfile } from '../packages/cli/src/adoption.js';

const profileId = 'cadfontautoreplace-f6331185';

describe('built-in adoption profiles', () => {
  it('keeps the CAD migration boundary explicit and preserves project-owned release inputs', async () => {
    const raw = JSON.parse(await readFile(
      new URL(`../templates/adoption/${profileId}.json`, import.meta.url),
      'utf8',
    )) as unknown;
    const profile = parseAdoptionProfile(raw, profileId);

    expect(profile.source).toEqual({
      repository: 'axiomoth/CADFontAutoReplace',
      commit: 'f6331185c12920cbb6d7b639f84a38b4d04ad71b',
    });
    expect(profile.replace.size).toBe(7);
    expect(profile.remove.size).toBe(25);
    expect(profile.remove.has('.github/scripts/generate-release-notes.ps1')).toBe(false);
    expect(profile.remove.has('.github/pr-classification-rules.json')).toBe(false);
    expect(profile.remove.has('.github/release.yml')).toBe(false);
    expect(profile.replace.has('.github/workflows/pr-validation-matrix.yml')).toBe(true);
    expect(profile.remove.has('.github/workflows/deploy-webhook-relay.yml')).toBe(true);
  });

  it('rejects profile id substitution, path overlap, and non-canonical digests', () => {
    const base = {
      schemaVersion: 1,
      id: 'safe-profile',
      source: { repository: 'splrad/example', commit: '1'.repeat(40) },
      replace: { '.github/dependabot.yml': 'a'.repeat(64) },
      remove: {},
    };
    expect(() => parseAdoptionProfile(base, 'different-profile')).toThrow('does not match');
    expect(() => parseAdoptionProfile({
      ...base,
      remove: { '.github/dependabot.yml': 'a'.repeat(64) },
    }, 'safe-profile')).toThrow('both replaced and removed');
    expect(() => parseAdoptionProfile({
      ...base,
      replace: { '.github/dependabot.yml': 'A'.repeat(64) },
    }, 'safe-profile')).toThrow('lowercase SHA-256');
  });
});
