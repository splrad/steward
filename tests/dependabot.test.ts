import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('generated consumer Dependabot policy', () => {
  it('groups every Steward reusable workflow dependency without matching unrelated Actions', async () => {
    const source = await readFile(new URL('../templates/init/dependabot.yml', import.meta.url), 'utf8');
    const configured = parse(source) as {
      updates: Array<{ groups?: Record<string, { patterns?: string[] }> }>;
    };
    const patterns = configured.updates[0]?.groups?.['steward-workflows']?.patterns;
    expect(patterns).toEqual(['splrad/steward/.github/workflows/*']);

    const directory = new URL('../templates/thin-workflows/', import.meta.url);
    const dependencies: string[] = [];
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.yml')) continue;
      const workflow = await readFile(new URL(file, directory), 'utf8');
      dependencies.push(...[...workflow.matchAll(/uses:\s+(splrad\/steward\/\.github\/workflows\/[^@\s]+)@/g)]
        .map((match) => match[1] ?? ''));
    }
    expect(dependencies).toHaveLength(8);
    expect(dependencies.every((dependency) => dependency.startsWith('splrad/steward/.github/workflows/'))).toBe(true);
    expect('actions/checkout').not.toMatch(/^splrad\/steward\/\.github\/workflows\//);
  });
});
