import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import manifestSchema from '../../../schema/steward.schema.json' with { type: 'json' };
import type { ClassificationConfiguration, StewardManifest } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(manifestSchema);

export class ManifestValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid Steward manifest:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ManifestValidationError';
    this.issues = issues;
  }
}

function schemaIssue(error: ErrorObject): string {
  const location = error.instancePath || '/';
  if (error.keyword === 'additionalProperties') {
    return `${location} contains unknown property "${String(error.params.additionalProperty)}"`;
  }
  if (error.keyword === 'required') {
    return `${location} is missing required property "${String(error.params.missingProperty)}"`;
  }
  return `${location} ${error.message ?? 'is invalid'}`;
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) duplicates.add(value);
    else seen.add(key);
  }
  return [...duplicates];
}

function classificationIssues(classification: ClassificationConfiguration): string[] {
  const issues: string[] = [];
  const duplicateAreas = duplicateValues(classification.areas.map((area) => area.name));
  const duplicateLabels = duplicateValues(classification.labels.public.map((label) => label.name));
  const duplicateTypes = duplicateValues(
    classification.decisions.kinds.byConventionalType.map((mapping) => mapping.type),
  );
  const duplicatePublicRules = duplicateValues(
    classification.decisions.publicLabels.rules.map((rule) => rule.label),
  );
  const duplicateKindFallbacks = duplicateValues(
    classification.decisions.publicLabels.fallbackByKind.map((mapping) => mapping.kind),
  );
  const duplicateReleaseCategories = duplicateValues(
    classification.releaseCategories.map((category) => category.releaseLabel),
  );
  const releaseLabels = new Set(classification.labels.release.map((label) => label.toLowerCase()));
  const publicLabels = new Set(classification.labels.public.map((label) => label.name.toLowerCase()));
  const areaNames = new Set(classification.areas.map((area) => area.name.toLowerCase()));
  const conventionalTypes = new Set(
    classification.decisions.kinds.byConventionalType.map((mapping) => mapping.type.toLowerCase()),
  );
  const kinds = new Set([
    ...classification.decisions.kinds.byConventionalType.map((mapping) => mapping.kind.toLowerCase()),
    classification.decisions.kinds.docsOnly.kind.toLowerCase(),
    classification.decisions.kinds.fallback.toLowerCase(),
  ]);
  const fallbackCategories = classification.releaseCategories.filter((category) => category.fallback);

  if (duplicateAreas.length) issues.push(`/classification/areas contains duplicate names: ${duplicateAreas.join(', ')}`);
  if (duplicateLabels.length) issues.push(`/classification/labels/public contains duplicate names: ${duplicateLabels.join(', ')}`);
  if (duplicateTypes.length) issues.push(`/classification/decisions/kinds/byConventionalType contains duplicate types: ${duplicateTypes.join(', ')}`);
  if (duplicatePublicRules.length) issues.push(`/classification/decisions/publicLabels/rules contains duplicate labels: ${duplicatePublicRules.join(', ')}`);
  if (duplicateKindFallbacks.length) issues.push(`/classification/decisions/publicLabels/fallbackByKind contains duplicate kinds: ${duplicateKindFallbacks.join(', ')}`);
  if (duplicateReleaseCategories.length) issues.push(`/classification/releaseCategories contains duplicate release labels: ${duplicateReleaseCategories.join(', ')}`);
  if (fallbackCategories.length !== 1) issues.push('/classification/releaseCategories must contain exactly one fallback category');

  for (const [index, rule] of classification.decisions.kinds.docsOnly.pathRules.entries()) {
    if (![rule.prefixes, rule.files, rule.suffixes].some((values) => values?.length)) {
      issues.push(`/classification/decisions/kinds/docsOnly/pathRules/${index} must contain a non-empty include condition`);
    }
  }

  for (const [index, rule] of classification.decisions.publicLabels.rules.entries()) {
    const path = `/classification/decisions/publicLabels/rules/${index}`;
    const conditions = rule.whenAny;
    if (![conditions.kinds, conditions.areas, conditions.conventionalTypes].some((values) => values?.length)
      && conditions.bot !== true) {
      issues.push(`${path}/whenAny must contain a non-empty condition`);
    }
    if (!publicLabels.has(rule.label.toLowerCase())) {
      issues.push(`${path} references unknown public label: ${rule.label}`);
    }
    for (const kind of conditions.kinds ?? []) {
      if (!kinds.has(kind.toLowerCase())) issues.push(`${path}/whenAny/kinds references unknown kind: ${kind}`);
    }
    for (const area of conditions.areas ?? []) {
      if (!areaNames.has(area.toLowerCase())) issues.push(`${path}/whenAny/areas references unknown area: ${area}`);
    }
    for (const type of conditions.conventionalTypes ?? []) {
      if (!conventionalTypes.has(type.toLowerCase())) {
        issues.push(`${path}/whenAny/conventionalTypes references unknown type: ${type}`);
      }
    }
  }

  for (const [index, fallback] of classification.decisions.publicLabels.fallbackByKind.entries()) {
    const path = `/classification/decisions/publicLabels/fallbackByKind/${index}`;
    if (!kinds.has(fallback.kind.toLowerCase())) issues.push(`${path} references unknown kind: ${fallback.kind}`);
    if (!publicLabels.has(fallback.label.toLowerCase())) issues.push(`${path} references unknown public label: ${fallback.label}`);
  }
  if (!publicLabels.has(classification.decisions.publicLabels.fallback.toLowerCase())) {
    issues.push(`/classification/decisions/publicLabels/fallback references unknown public label: ${classification.decisions.publicLabels.fallback}`);
  }

  for (const label of classification.labels.release) {
    if (!publicLabels.has(label.toLowerCase())) {
      issues.push(`/classification/labels/release references unknown public label: ${label}`);
    }
  }
  for (const category of classification.releaseCategories) {
    if (!releaseLabels.has(category.releaseLabel.toLowerCase())) {
      issues.push(`/classification/releaseCategories references unknown release label: ${category.releaseLabel}`);
    }
    for (const pattern of category.textPatterns) {
      try {
        new RegExp(pattern, 'i');
      } catch {
        issues.push(`/classification/releaseCategories contains invalid text pattern: ${pattern}`);
      }
    }
  }
  return issues;
}

export function parseManifest(value: unknown): StewardManifest {
  if (!validateSchema(value)) {
    throw new ManifestValidationError((validateSchema.errors ?? []).map(schemaIssue));
  }

  const manifest = value as unknown as StewardManifest;
  const issues = manifest.classification ? classificationIssues(manifest.classification) : [];
  if (issues.length) throw new ManifestValidationError(issues);
  return manifest;
}
