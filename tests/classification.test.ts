import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  evaluateClassification,
  renderClassificationMetadata,
  upsertClassificationMetadata,
} from '../packages/core/src/index.js';
import { parseManifest, type ClassificationConfiguration } from '../packages/manifest/src/index.js';

const classification = JSON.parse(await readFile(
  new URL('./fixtures/cadfontautoreplace/classification.json', import.meta.url),
  'utf8',
)) as ClassificationConfiguration;

parseManifest({
  schemaVersion: 1,
  automation: {
    githubApp: { clientId: 'Iv23liuSr0qd4WLJdZhH', slug: 'splrad-steward' },
    maintainers: { source: 'organization-team', teamSlug: 'maintainers' },
    language: 'zh-CN',
  },
  features: {
    prAutomation: false,
    classification: true,
    dcoAdvisory: false,
    governance: false,
    copilotReview: false,
    release: false,
    webhookRelay: false,
  },
  classification,
});

describe('classification evaluator', () => {
  it.each([
    {
      name: 'feature runtime change',
      facts: { title: 'feat: add fallback', files: ['src/Plugin.cs'] },
      expected: {
        areas: ['area:runtime'],
        kind: 'kind:feature',
        publicLabels: ['feature'],
        releaseLabels: ['feature'],
      },
    },
    {
      name: 'explicit documentation change',
      facts: { title: 'docs: clarify setup', files: ['README.md'] },
      expected: {
        areas: ['area:docs'],
        kind: 'kind:docs',
        publicLabels: ['documentation'],
        releaseLabels: [],
      },
    },
    {
      name: 'docs-only change without a conventional title',
      facts: { title: 'Clarify design', files: ['notes/decision.md'] },
      expected: {
        areas: [],
        kind: 'kind:docs',
        publicLabels: ['documentation'],
        releaseLabels: [],
      },
    },
    {
      name: 'excluded GitHub markdown path',
      facts: { title: 'Clarify automation', files: ['.github/notes.md'] },
      expected: {
        areas: [],
        kind: 'kind:chore',
        publicLabels: ['chore'],
        releaseLabels: [],
      },
    },
    {
      name: 'workflow change',
      facts: { title: 'ci: update checks', files: ['.github/workflows/ci.yml'] },
      expected: {
        areas: ['area:workflow'],
        kind: 'kind:chore',
        publicLabels: ['workflow'],
        releaseLabels: [],
      },
    },
    {
      name: 'bot packaging change',
      facts: {
        title: 'build: update dependencies',
        author: { login: 'dependabot[bot]', type: 'Bot' },
        files: ['Directory.Packages.props'],
      },
      expected: {
        areas: ['area:runtime', 'area:config'],
        kind: 'kind:chore',
        publicLabels: ['build', 'chore'],
        releaseLabels: ['build'],
      },
    },
    {
      name: 'runtime fallback release category',
      facts: { title: 'Update native hook', files: ['src/NativeHook.cpp'] },
      expected: {
        areas: ['area:runtime'],
        kind: 'kind:chore',
        publicLabels: ['plugin'],
        releaseLabels: ['plugin'],
      },
    },
    {
      name: 'explicitly excluded runtime release file',
      facts: { title: 'fix: align version metadata', files: ['Version.props'] },
      expected: {
        areas: ['area:release', 'area:config'],
        kind: 'kind:fix',
        publicLabels: ['bug'],
        releaseLabels: [],
      },
    },
    {
      name: 'multiple ordered release categories',
      facts: { title: 'fix: security hardening', files: ['src/Security.cs'] },
      expected: {
        areas: ['area:runtime'],
        kind: 'kind:fix',
        publicLabels: ['security', 'bug'],
        releaseLabels: ['security', 'bug'],
      },
    },
  ])('matches the CADFontAutoReplace contract for $name', ({ facts, expected }) => {
    expect(evaluateClassification(facts, classification).decision).toEqual(expected);
  });

  it('keeps conventional type precedence over docs-only paths and supports scoped breaking titles', () => {
    expect(evaluateClassification({
      title: 'fix(ui)!: document breaking behavior',
      files: ['README.md'],
    }, classification).decision).toEqual({
      areas: ['area:docs'],
      kind: 'kind:fix',
      publicLabels: ['documentation'],
      releaseLabels: [],
    });
  });

  it('produces a pure presentation and GitHub mutation plan from caller-supplied facts', () => {
    const evaluation = evaluateClassification({
      title: 'feat: add option',
      files: ['src/Options.cs'],
      currentLabels: ['Documentation', 'Area:Docs', 'external-label'],
    }, classification);

    expect(evaluation.presentation).toEqual({
      areas: ['area:runtime'],
      kind: 'kind:feature',
      visibleLabels: ['feature'],
      releaseLabels: ['feature'],
    });
    expect(evaluation.mutationPlan.addLabels).toEqual(['feature']);
    expect(evaluation.mutationPlan.removePublicLabels).toEqual(['Documentation']);
    expect(evaluation.mutationPlan.removeInternalLabels).toEqual(['Area:Docs']);
    expect(evaluation.mutationPlan.ensureLabels.map((label) => label.name)).toEqual(['feature']);

    const existingWithDifferentCase = evaluateClassification({
      title: 'feat: add option',
      files: ['src/Options.cs'],
      currentLabels: ['FEATURE'],
    }, classification);
    expect(existingWithDifferentCase.mutationPlan.addLabels).toEqual([]);
    expect(existingWithDifferentCase.mutationPlan.removePublicLabels).toEqual([]);
  });

  it('uses consumer-provided kinds and labels without shared hard-coding', () => {
    const custom = structuredClone(classification);
    custom.decisions.kinds.byConventionalType.find((mapping) => mapping.type === 'feat')!.kind = 'change:new';
    custom.decisions.publicLabels.fallbackByKind.find((mapping) => mapping.kind === 'kind:feature')!.kind = 'change:new';
    custom.decisions.publicLabels.fallbackByKind.find((mapping) => mapping.kind === 'change:new')!.label = 'enhancement';
    custom.labels.public.find((label) => label.name === 'feature')!.name = 'enhancement';
    custom.labels.release[2] = 'enhancement';
    custom.releaseCategories.find((category) => category.releaseLabel === 'feature')!.releaseLabel = 'enhancement';

    expect(evaluateClassification({
      title: 'feat: add reusable policy',
      files: ['src/Policy.cs'],
    }, custom).decision).toEqual({
      areas: ['area:runtime'],
      kind: 'change:new',
      publicLabels: ['enhancement'],
      releaseLabels: ['enhancement'],
    });
  });

  it('renders one canonical compatibility metadata block without changing contributor text', () => {
    const presentation = evaluateClassification({
      title: 'feat: add option',
      files: ['src/Options.cs'],
    }, classification).presentation;
    expect(renderClassificationMetadata(presentation)).toBe([
      '<!-- workflow:pr-classification:start',
      'areas=area:runtime',
      'kind=kind:feature',
      'visible-labels=feature',
      'release-labels=feature',
      'workflow:pr-classification:end -->',
    ].join('\n'));
    expect(upsertClassificationMetadata([
      'Contributor context',
      '<!-- workflow:pr-classification:start',
      'visible-labels=stale',
      'workflow:pr-classification:end -->',
      '<!-- workflow:pr-classification:start',
      'visible-labels=duplicate',
      'workflow:pr-classification:end -->',
    ].join('\n'), presentation)).toBe(`Contributor context\n\n${renderClassificationMetadata(presentation)}`);
  });
});
