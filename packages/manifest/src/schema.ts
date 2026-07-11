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
  const releaseLabels = new Set(classification.labels.release.map((label) => label.toLowerCase()));
  const publicLabels = new Set(classification.labels.public.map((label) => label.name.toLowerCase()));
  const fallbackCategories = classification.releaseCategories.filter((category) => category.fallback);

  if (duplicateAreas.length) issues.push(`/classification/areas contains duplicate names: ${duplicateAreas.join(', ')}`);
  if (duplicateLabels.length) issues.push(`/classification/labels/public contains duplicate names: ${duplicateLabels.join(', ')}`);
  if (fallbackCategories.length !== 1) issues.push('/classification/releaseCategories must contain exactly one fallback category');

  for (const label of classification.labels.release) {
    if (!publicLabels.has(label.toLowerCase())) {
      issues.push(`/classification/labels/release references unknown public label: ${label}`);
    }
  }
  for (const category of classification.releaseCategories) {
    if (!releaseLabels.has(category.releaseLabel.toLowerCase())) {
      issues.push(`/classification/releaseCategories references unknown release label: ${category.releaseLabel}`);
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
