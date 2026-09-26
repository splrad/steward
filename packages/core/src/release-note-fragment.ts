import { minimatch } from 'minimatch';

export type FragmentEntry = { change: string; userImpact: string } & (
  { actionRequired: false } | { actionRequired: true; action: string }
);
export type Fragment =
  | { schemaVersion: 1; status: 'documented'; entries: FragmentEntry[] }
  | { schemaVersion: 1; status: 'not-user-facing'; reason: string };
export type FragmentErrorCode = 'RN_FRAGMENT_ENCODING' | 'RN_FRAGMENT_JSON' | 'RN_FRAGMENT_DUPLICATE_KEY'
  | 'RN_FRAGMENT_SCHEMA' | 'RN_FRAGMENT_TEXT' | 'RN_FRAGMENT_ID' | 'RN_PATH_INVALID'
  | 'RN_PROFILE_INVALID' | 'RN_FRAGMENT_REQUIRED' | 'RN_FACT_CONFLICT';

export class FragmentError extends Error {
  constructor(public readonly code: FragmentErrorCode, public readonly field: string) {
    super(`${code}: ${field}`);
    this.name = 'FragmentError';
  }
}

function fail(code: FragmentErrorCode, field: string): never { throw new FragmentError(code, field); }
const forbiddenCharacters = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;

function checkString(value: string, field: string): void {
  if (/[\ud800-\udfff]/u.test(value) || forbiddenCharacters.test(value)) fail('RN_FRAGMENT_TEXT', field);
}

// The caller validates JSON syntax before scanning tokens from left to right.
function* jsonTokens(source: string): Generator<string> {
  let cursor = 0;
  while (cursor < source.length) {
    const start = cursor;
    const character = source[cursor++]!;
    if (' \t\r\n'.includes(character)) continue;
    if (character === '"') {
      while (cursor < source.length) {
        const next = source[cursor++]!;
        if (next === '\\') cursor++;
        else if (next === '"') break;
      }
    } else if (!'{}[],:'.includes(character)) {
      while (cursor < source.length && !' \t\r\n{}[],:'.includes(source[cursor]!)) cursor++;
    }
    yield source.slice(start, cursor);
  }
}

function readJson(bytes: Uint8Array): unknown {
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail('RN_FRAGMENT_ENCODING', '$'); }
  if (source.startsWith('\ufeff')) fail('RN_FRAGMENT_ENCODING', '$');
  let value: unknown;
  try { value = JSON.parse(source) as unknown; }
  catch { return fail('RN_FRAGMENT_JSON', '$'); }

  // JSON.parse validates syntax; token inspection preserves duplicate object keys.
  const stack: ({ keys: Set<string>; expectingKey: boolean } | null)[] = [];
  for (const token of jsonTokens(source)) {
    if (token === '{') stack.push({ keys: new Set(), expectingKey: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { const frame = stack.at(-1); if (frame) frame.expectingKey = true; }
    else if (token.startsWith('"')) {
      const text = JSON.parse(token) as string;
      checkString(text, '$');
      const frame = stack.at(-1);
      if (frame?.expectingKey) {
        if (frame.keys.has(text)) fail('RN_FRAGMENT_DUPLICATE_KEY', '$');
        frame.keys.add(text);
        frame.expectingKey = false;
      }
    } else if (/^-?\d/.test(token) && !Number.isFinite(Number(token))) fail('RN_FRAGMENT_JSON', '$');
  }
  return value;
}

function object(value: unknown, allowed: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('RN_FRAGMENT_SCHEMA', field);
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('RN_FRAGMENT_SCHEMA', field);
  return value as Record<string, unknown>;
}

function hasInlineFormatting(value: string): boolean {
  const characters = [...value];
  const openers: { marker: string; length: number; canClose: boolean }[] = [];
  const whitespace = (character: string) => /\s/u.test(character);
  const punctuation = (character: string) => /[\p{P}\p{S}]/u.test(character);
  for (let index = 0; index < characters.length;) {
    const marker = characters[index++]!;
    if (marker === '\\' && /[!-/:-@\[-`{-~]/u.test(characters[index] ?? '')) { index++; continue; }
    if (!'*_~'.includes(marker)) continue;
    const start = index - 1;
    while (characters[index] === marker) index++;
    const length = index - start;
    const before = characters[start - 1] ?? ' ';
    const after = characters[index] ?? ' ';
    const left = !whitespace(after) && (!punctuation(after) || whitespace(before) || punctuation(before));
    const right = !whitespace(before) && (!punctuation(before) || whitespace(after) || punctuation(after));
    const canOpen = marker === '_' ? left && (!right || punctuation(before)) : left;
    const canClose = marker === '_' ? right && (!left || punctuation(after)) : right;
    if (canClose && openers.some((opener) => {
      if (opener.marker !== marker) return false;
      if (marker === '~') return length <= 2 && opener.length === length;
      return !(opener.canClose || canOpen) || (opener.length + length) % 3 !== 0
        || (opener.length % 3 === 0 && length % 3 === 0);
    })) return true;
    if (canOpen) openers.push({ marker, length, canClose });
  }
  return false;
}

function text(value: unknown, min: number, field: string): string {
  if (typeof value !== 'string') fail('RN_FRAGMENT_SCHEMA', field);
  checkString(value, field);
  const normalized = value.normalize('NFC').trim();
  const length = [...normalized].length;
  if (length < min || length > 240) fail('RN_FRAGMENT_TEXT', field);
  if (hasInlineFormatting(normalized)) fail('RN_FRAGMENT_TEXT', field);
  if (/`|~{3}|!?\[[^\]]*\]\s*[(:\[]|<\/?[a-z!][^>]*>|(?:[a-z][a-z\d+.-]*:\/\/|\b(?:mailto|data|javascript):|\bwww\.)|^(?:#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s)|\||\{\{|\}\}|\$\{|<%|%>|\{[a-z_][\w.-]*\}/iu.test(normalized)) {
    fail('RN_FRAGMENT_TEXT', field);
  }
  return normalized;
}

export function parseFragment(bytes: Uint8Array): Fragment {
  const data = object(readJson(bytes), ['schemaVersion', 'status', 'entries', 'reason'], '$');
  if (data.schemaVersion !== 1) fail('RN_FRAGMENT_SCHEMA', 'schemaVersion');
  if (data.status === 'not-user-facing') {
    if ('entries' in data) fail('RN_FRAGMENT_SCHEMA', 'entries');
    return { schemaVersion: 1, status: data.status, reason: text(data.reason, 10, 'reason') };
  }
  if (data.status !== 'documented' || 'reason' in data || !Array.isArray(data.entries)
    || data.entries.length < 1 || data.entries.length > 5) fail('RN_FRAGMENT_SCHEMA', 'entries');
  const entries = data.entries.map((value: unknown, index: number): FragmentEntry => {
    const field = `entries[${index}]`;
    const entry = object(value, ['change', 'userImpact', 'actionRequired', 'action'], field);
    const change = text(entry.change, 10, `${field}.change`);
    const userImpact = text(entry.userImpact, 10, `${field}.userImpact`);
    if (entry.actionRequired === true) return { change, userImpact, actionRequired: true, action: text(entry.action, 5, `${field}.action`) };
    if (entry.actionRequired !== false || 'action' in entry) fail('RN_FRAGMENT_SCHEMA', `${field}.actionRequired`);
    return { change, userImpact, actionRequired: false };
  });
  return { schemaVersion: 1, status: 'documented', entries };
}

export type Requirement = 'ignored' | 'review-required' | 'required';
export interface FragmentProfile {
  fragmentDirectory: string;
  required: readonly string[];
  reviewRequired: readonly string[];
  ignored: readonly string[];
}
export interface FragmentClassification { primaryKind: string; riskFlags: readonly string[] }
export type FragmentPathChange =
  | { status: 'added' | 'modified' | 'removed'; path: string }
  | { status: 'renamed'; path: string; previousPath: string };
export interface RequirementDecision {
  requirement: Requirement;
  classificationState: 'provided' | 'missing';
  paths: { path: string; requirement: Requirement }[];
}
const rank: Record<Requirement, number> = { ignored: 0, 'review-required': 1, required: 2 };
const higher = (left: Requirement, right: Requirement): Requirement => rank[left] >= rank[right] ? left : right;

function relativePath(value: string, code: 'RN_PATH_INVALID' | 'RN_PROFILE_INVALID'): string {
  if (!value || /[\ud800-\udfff]/u.test(value) || forbiddenCharacters.test(value) || /[\\:]/u.test(value)
    || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')) fail(code, 'path');
  return value;
}

function validateFragmentDirectory(directory: string): void {
  relativePath(directory, 'RN_PROFILE_INVALID');
  if (/[*!?{}()[\]]/u.test(directory)) fail('RN_PROFILE_INVALID', 'fragmentDirectory');
}

export function validateFragmentProfile(profile: FragmentProfile): void {
  validateFragmentDirectory(profile.fragmentDirectory);
  for (const patterns of [profile.required, profile.reviewRequired, profile.ignored]) {
    for (const pattern of patterns) {
      relativePath(pattern, 'RN_PROFILE_INVALID');
      if (/[!{}()[\]]/u.test(pattern) || pattern.split('/').some((part) => part.includes('**') && part !== '**')) {
        fail('RN_PROFILE_INVALID', 'pattern');
      }
    }
  }
}

export function fragmentIdFromPath(path: string, directory = '.release-notes/fragments'): string {
  relativePath(path, 'RN_PATH_INVALID');
  validateFragmentDirectory(directory);
  if (!path.startsWith(`${directory}/`)) fail('RN_FRAGMENT_ID', 'path');
  const name = path.slice(directory.length + 1);
  if (!/^[a-z0-9-]{8,64}\.json$/u.test(name)) fail('RN_FRAGMENT_ID', 'path');
  return name.slice(0, -5);
}

export function evaluateRequirement(
  changes: readonly FragmentPathChange[], classification: FragmentClassification | null, profile: FragmentProfile,
): RequirementDecision {
  validateFragmentProfile(profile);
  const matchOptions = { dot: true, nocase: false, matchBase: false, nobrace: true, noext: true,
    nonegate: true, nocomment: true, noglobstar: false, platform: 'linux' as const,
    windowsPathsNoEscape: false, preserveMultipleSlashes: false, optimizationLevel: 0 };
  const paths = changes.flatMap((change) => change.status === 'renamed' ? [change.previousPath, change.path] : [change.path])
    .map((input): { path: string; requirement: Requirement } => {
      const path = relativePath(input, 'RN_PATH_INVALID');
      if (path.startsWith(`${profile.fragmentDirectory}/`)) return { path, requirement: 'ignored' };
      for (const [requirement, patterns] of [ ['required', profile.required], ['review-required', profile.reviewRequired], ['ignored', profile.ignored] ] as const) {
        if (patterns.some((pattern) => minimatch(path, pattern, matchOptions))) return { path, requirement };
      }
      return { path, requirement: 'review-required' };
    });
  let requirement = paths.reduce<Requirement>((result, entry) => higher(result, entry.requirement), 'ignored');
  if (classification) {
    if (['feature', 'bug', 'performance'].includes(classification.primaryKind)) requirement = higher(requirement, 'review-required');
    if (classification.riskFlags.some((risk) => risk === 'security' || risk === 'breaking-change')) requirement = 'required';
  }
  return { requirement, classificationState: classification ? 'provided' : 'missing', paths };
}

export function validateFragmentRequirement(
  fragment: Fragment | null, decision: RequirementDecision, classification: FragmentClassification | null,
): void {
  if (!fragment) {
    if (decision.requirement !== 'ignored' || classification?.riskFlags.some((risk) => risk === 'security' || risk === 'breaking-change')) {
      fail('RN_FRAGMENT_REQUIRED', 'fragment');
    }
    return;
  }
  const risks = classification?.riskFlags ?? [];
  if (fragment.status === 'not-user-facing' && risks.some((risk) => risk === 'security' || risk === 'breaking-change')) fail('RN_FACT_CONFLICT', 'status');
  if (risks.includes('breaking-change') && (fragment.status !== 'documented' || !fragment.entries.some((entry) => entry.actionRequired))) {
    fail('RN_FACT_CONFLICT', 'actionRequired');
  }
}
