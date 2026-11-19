import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { releaseBodyMatches } from '../src/release-body.js';

it('accepts the reviewed public correction only for the original immutable release and notes', () => {
  const body = readFileSync('packages/runner/test/fixtures/layerscape-v1.0.0-body.md', 'utf8');
  const args = [1187527897, 450956063, '3755e1426c3d9776927658480fe610b298c27813', 'v1.0.0',
    body, 'e785967b2c50daa56569b2fd71273f5bab1afbd927d97da0a3eb45c2c9483e7e'] as const;
  expect(releaseBodyMatches(...args)).toBe(true);
  for (let index = 0; index < args.length; index++) {
    const changed: Parameters<typeof releaseBodyMatches> = [...args];
    Object.assign(changed, { [index]: typeof args[index] === 'number' ? 1 : args[index] + 'x' });
    expect(releaseBodyMatches(...changed)).toBe(false);
  }
});
