import type {
  ClassificationConfiguration,
  DocsOnlyPathRuleConfiguration,
  PublicLabelConfiguration,
} from '../../manifest/src/index.js';
import { normalizeRepositoryPath } from './fingerprint.js';

export interface PullRequestClassificationFacts {
  title: string;
  body?: string | null;
  headRef?: string;
  baseRef?: string;
  author?: {
    login?: string;
    type?: string;
  };
  files: string[];
  currentLabels?: string[];
}

export interface ClassificationDecision {
  areas: string[];
  kind: string;
  publicLabels: string[];
  releaseLabels: string[];
}

export interface ClassificationEvaluation {
  decision: ClassificationDecision;
  presentation: {
    areas: string[];
    kind: string;
    visibleLabels: string[];
    releaseLabels: string[];
  };
  mutationPlan: {
    ensureLabels: PublicLabelConfiguration[];
    addLabels: string[];
    removePublicLabels: string[];
    removeInternalLabels: string[];
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  const value = normalizeRepositoryPath(pattern);
  let regex = '^';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '*') {
      if (value[index + 1] === '*') {
        regex += '.*';
        index += 1;
      } else {
        regex += '[^/]*';
      }
    } else {
      regex += escapeRegex(character ?? '');
    }
  }
  return new RegExp(`${regex}$`);
}

function matchesAnyPattern(file: string, patterns: string[]): boolean {
  const normalized = normalizeRepositoryPath(file);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

function conventionalType(title: string, classification: ClassificationConfiguration): string {
  const configuredTypes = classification.decisions.kinds.byConventionalType.map((mapping) => mapping.type);
  if (!configuredTypes.length) return '';
  const alternatives = [...configuredTypes]
    .sort((left, right) => right.length - left.length || compareText(left, right))
    .map(escapeRegex)
    .join('|');
  return title.match(new RegExp(`^(${alternatives})(?:\\([a-z0-9-]+\\))?!?:`, 'i'))?.[1]?.toLowerCase() ?? '';
}

function docsPathRuleMatches(file: string, rule: DocsOnlyPathRuleConfiguration): boolean {
  const normalized = normalizeRepositoryPath(file);
  if ((rule.excludePrefixes ?? []).some((prefix) => normalized.startsWith(normalizeRepositoryPath(prefix)))) {
    return false;
  }
  return (rule.prefixes ?? []).some((prefix) => normalized.startsWith(normalizeRepositoryPath(prefix)))
    || (rule.files ?? []).some((candidate) => normalized === normalizeRepositoryPath(candidate))
    || (rule.suffixes ?? []).some((suffix) => normalized.endsWith(suffix.toLowerCase()));
}

function isDocsOnly(files: string[], classification: ClassificationConfiguration): boolean {
  const rules = classification.decisions.kinds.docsOnly.pathRules;
  return files.length > 0 && files.every((file) => rules.some((rule) => docsPathRuleMatches(file, rule)));
}

function pathRuleMatches(
  file: string,
  rule: {
    includePrefixes?: string[];
    includeFiles?: string[];
    excludePrefixes?: string[];
    excludeFiles?: string[];
  },
): boolean {
  const normalized = normalizeRepositoryPath(file);
  if ((rule.excludePrefixes ?? []).some((prefix) => normalized.startsWith(normalizeRepositoryPath(prefix)))) return false;
  if ((rule.excludeFiles ?? []).some((candidate) => normalized === normalizeRepositoryPath(candidate))) return false;
  return (rule.includePrefixes ?? []).some((prefix) => normalized.startsWith(normalizeRepositoryPath(prefix)))
    || (rule.includeFiles ?? []).some((candidate) => normalized === normalizeRepositoryPath(candidate));
}

function orderedLabels(labels: Iterable<string>, classification: ClassificationConfiguration): string[] {
  const order = new Map(classification.labels.public.map((label, index) => [label.name.toLowerCase(), index]));
  return [...new Set(labels)].sort((left, right) => {
    return (order.get(left.toLowerCase()) ?? 1000) - (order.get(right.toLowerCase()) ?? 1000)
      || compareText(left, right);
  });
}

function canonicalPublicLabel(label: string, classification: ClassificationConfiguration): string {
  return classification.labels.public.find((candidate) => candidate.name.toLowerCase() === label.toLowerCase())?.name
    ?? label;
}

function inferAreas(files: string[], classification: ClassificationConfiguration): string[] {
  return classification.areas
    .filter((area) => files.some((file) => matchesAnyPattern(file, area.patterns)))
    .map((area) => area.name);
}

function inferKind(type: string, files: string[], classification: ClassificationConfiguration): string {
  const mapped = classification.decisions.kinds.byConventionalType
    .find((mapping) => mapping.type.toLowerCase() === type)?.kind;
  if (mapped) return mapped;
  if (isDocsOnly(files, classification)) return classification.decisions.kinds.docsOnly.kind;
  return classification.decisions.kinds.fallback;
}

function inferReleaseLabels(facts: PullRequestClassificationFacts, classification: ClassificationConfiguration): string[] {
  const runtimeFiles = facts.files.filter((file) => pathRuleMatches(file, classification.runtimeRelease));
  if (!runtimeFiles.length) return [];
  const text = [facts.title, facts.body, facts.headRef, facts.baseRef].filter(Boolean).join('\n');
  const labels = new Set<string>();

  for (const category of classification.releaseCategories) {
    if (category.fallback) continue;
    const matchesText = category.textPatterns.some((pattern) => new RegExp(pattern, 'i').test(text));
    const matchesInstallOrPackage = category.installOrPackage
      && runtimeFiles.some((file) => pathRuleMatches(file, classification.installOrPackage));
    if (matchesText || matchesInstallOrPackage) {
      labels.add(canonicalPublicLabel(category.releaseLabel, classification));
    }
  }
  if (!labels.size) {
    const fallback = classification.releaseCategories.find((category) => category.fallback);
    if (fallback) labels.add(canonicalPublicLabel(fallback.releaseLabel, classification));
  }
  const allowedReleaseLabels = new Set(classification.labels.release.map((label) => label.toLowerCase()));
  return orderedLabels(
    [...labels].filter((label) => allowedReleaseLabels.has(label.toLowerCase())),
    classification,
  );
}

function isBotAuthor(facts: PullRequestClassificationFacts): boolean {
  return (facts.author?.login ?? '').endsWith('[bot]') || facts.author?.type === 'Bot';
}

function inferPublicLabels(
  type: string,
  areas: string[],
  kind: string,
  releaseLabels: string[],
  facts: PullRequestClassificationFacts,
  classification: ClassificationConfiguration,
): string[] {
  const labels = new Set(releaseLabels);
  const areaNames = new Set(areas.map((area) => area.toLowerCase()));
  for (const rule of classification.decisions.publicLabels.rules) {
    const when = rule.whenAny;
    const matches = (when.kinds ?? []).some((candidate) => candidate.toLowerCase() === kind.toLowerCase())
      || (when.areas ?? []).some((candidate) => areaNames.has(candidate.toLowerCase()))
      || (when.conventionalTypes ?? []).some((candidate) => candidate.toLowerCase() === type)
      || (when.bot === true && isBotAuthor(facts));
    if (matches) labels.add(canonicalPublicLabel(rule.label, classification));
  }

  if (!labels.size) {
    const mapped = classification.decisions.publicLabels.fallbackByKind
      .find((fallback) => fallback.kind.toLowerCase() === kind.toLowerCase())?.label;
    labels.add(canonicalPublicLabel(mapped ?? classification.decisions.publicLabels.fallback, classification));
  }
  return orderedLabels(labels, classification);
}

export function evaluateClassification(
  facts: PullRequestClassificationFacts,
  classification: ClassificationConfiguration,
): ClassificationEvaluation {
  const type = conventionalType(facts.title, classification);
  const areas = inferAreas(facts.files, classification);
  const kind = inferKind(type, facts.files, classification);
  const releaseLabels = inferReleaseLabels(facts, classification);
  const publicLabels = inferPublicLabels(type, areas, kind, releaseLabels, facts, classification);
  const decision = { areas, kind, publicLabels, releaseLabels };
  const currentLabels = facts.currentLabels ?? [];
  const desiredLabels = new Set(publicLabels);
  const managedLabels = new Set(classification.labels.public.map((label) => label.name));
  const addLabels = publicLabels.filter((label) => !currentLabels.includes(label));

  return {
    decision,
    presentation: {
      areas: [...areas],
      kind,
      visibleLabels: [...publicLabels],
      releaseLabels: [...releaseLabels],
    },
    mutationPlan: {
      ensureLabels: classification.labels.public.filter((label) => addLabels.includes(label.name)),
      addLabels,
      removePublicLabels: currentLabels.filter((label) => managedLabels.has(label) && !desiredLabels.has(label)),
      removeInternalLabels: currentLabels.filter((label) => (
        classification.labels.internalPrefixes.some((prefix) => label.startsWith(prefix))
      )),
    },
  };
}
