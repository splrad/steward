import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { ClassificationDecision } from '../src/classification.js';
import { evaluateRequirement, fragmentIdFromPath, FragmentError, parseFragment, validateFragmentProfile,
  validateFragmentRequirement, toFragmentClassification, type FragmentClassification, type FragmentErrorCode, type FragmentProfile } from '../src/release-note-fragment.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const entry = { change: 'Failed tasks preserve the original data.', userImpact: 'Later tasks continue after a failure.', actionRequired: false };
const documented = { schemaVersion: 1, status: 'documented', entries: [entry] };
const hidden = { schemaVersion: 1, status: 'not-user-facing', reason: 'Only internal test fixtures have changed.' };
const profile: FragmentProfile = { fragmentDirectory: '.release-notes/fragments', required: ['src/**', 'docs/user/**'],
  reviewRequired: ['package.json', '.github/workflows/release.yml'], ignored: ['tests/**', 'docs/**', 'VERSION', '.github/**'] };
const validateSchema = new Ajv2020({ strict: true }).compile(JSON.parse(readFileSync(new URL('../../../schema/release-note-fragment.schema.json', import.meta.url), 'utf8')));
function errorCode(run: () => unknown, code: FragmentErrorCode): void {
  expect(run).toThrow(FragmentError);
  try { run(); } catch (error) { expect((error as FragmentError).code).toBe(code); }
}
const decision = (path: string, classification: FragmentClassification | null = null) => evaluateRequirement([{ status: 'modified', path }], classification, profile);

describe('T01: fragment bytes and JSON', () => {
  it('preserves escaped string boundaries and decoded duplicate keys', () => {
    const reason = 'Quoted "value", braces {}, brackets [] and slash \\ remain text.';
    expect(parseFragment(encode({ ...hidden, reason }))).toEqual({ ...hidden, reason });
    const source = '{"schemaVersion":1,"status":"not-user-facing","reason":"Escaped \\"quote\\" and braces {}","reas\\u006fn":"Duplicate reason value"}';
    errorCode(() => parseFragment(new TextEncoder().encode(source)), 'RN_FRAGMENT_DUPLICATE_KEY');
  });
  it('rejects long escaped inputs and retains duplicate-key detection after them', () => {
    const repeated = '\\"'.repeat(100_000);
    errorCode(() => parseFragment(encode({ ...hidden, reason: repeated })), 'RN_FRAGMENT_TEXT');
    errorCode(() => parseFragment(new TextEncoder().encode('"' + repeated)), 'RN_FRAGMENT_JSON');
    const source = '{"reason":' + JSON.stringify(repeated) + ',"reason":"Duplicate reason value"}';
    errorCode(() => parseFragment(new TextEncoder().encode(source)), 'RN_FRAGMENT_DUPLICATE_KEY');
  });
  it.each([42, null, {}])('rejects non-string actions in both validators %#', (action) => {
    const value = { ...documented, entries: [{ ...entry, actionRequired: true, action }] };
    expect(validateSchema(value)).toBe(false);
    errorCode(() => parseFragment(encode(value)), 'RN_FRAGMENT_SCHEMA');
  });
  it.each([documented, hidden])('accepts both fragment statuses', (value) => {
    expect(parseFragment(encode(value))).toEqual(value);
    expect(validateSchema(value)).toBe(true);
  });
  it.each([
    '{"schemaVersion":1,"schemaVersion":1}',
    '{"schemaVersion":1,"schemaVersi\\u006fn":1}',
    '{"nested":{"key":1,"key":2}}',
    '{"nested":[{"key":1,"key":2}]}',
  ])('rejects duplicate keys: %s', (source) => errorCode(() => parseFragment(new TextEncoder().encode(source)), 'RN_FRAGMENT_DUPLICATE_KEY'));
  it.each(['{', '{} trailing', '{"n":1e999}'])('rejects invalid JSON: %s', (source) => errorCode(() => parseFragment(new TextEncoder().encode(source)), 'RN_FRAGMENT_JSON'));
  it.each([new Uint8Array([0xc3, 0x28]), new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])])('rejects invalid encoding', (bytes) => errorCode(() => parseFragment(bytes), 'RN_FRAGMENT_ENCODING'));
  it.each([
    { ...documented, extra: true }, { ...documented, schemaVersion: 2 }, { ...documented, reason: 'Long enough reason' },
    { ...hidden, entries: [] }, { ...hidden, reason: undefined }, { ...documented, entries: [{ ...entry, extra: true }] },
    { ...documented, entries: [{ ...entry, actionRequired: 'false' }] },
    { ...documented, entries: [{ ...entry, action: 'Extra operation' }] },
    { ...documented, entries: [{ ...entry, actionRequired: true }] }, [], null,
  ])('rejects malformed structure %#', (value) => {
    errorCode(() => parseFragment(encode(value)), 'RN_FRAGMENT_SCHEMA');
    expect(validateSchema(value)).toBe(false);
  });
  it.each(['\ud800', '\udfff', '\n', '\r', '\t', '\u0000', '\u0085', '\u202e', '\u2066', '\u200f', '\ufeff'])('rejects unsafe characters %#', (character) => {
    errorCode(() => parseFragment(encode({ ...hidden, reason: `Long enough ${character} explanation.` })), 'RN_FRAGMENT_TEXT');
  });
});

describe('T02: text and entry boundaries', () => {
  it.each(['change', 'userImpact', 'reason', 'action'])('rejects thematic breaks in %s', (field) => {
    for (const content of ['----------', '__________', '**********', '-    -    -', '_    _    _', '*    *    *', '  --  ---  -----  ']) {
      const value = field === 'reason' ? { ...hidden, reason: content }
        : { ...documented, entries: [{ ...entry, ...(field === 'action' ? { actionRequired: true } : {}), [field]: content }] };
      errorCode(() => parseFragment(encode(value)), 'RN_FRAGMENT_TEXT');
    }
  });
  it.each(['Use ---------- as a literal separator.', 'The --dry-run option remains available.', '----------x', '____  ____x'])('preserves non-break punctuation: %s', (reason) => {
    expect(parseFragment(encode({ ...hidden, reason }))).toEqual({ ...hidden, reason });
  });
  it.each(['change', 'userImpact', 'reason', 'action'])('rejects inline formatting in %s', (field) => {
    for (const content of ['**breaking change**', '_important text_', '~~removed item~~',
      '*important text*', '__important text__', '***important text***', '~removed item~',
      'Before **bold _nested_ text** after.', '修复了**重要问题**并保留详细信息。',
      'Before (**important text**) after.', 'The __init__ method retains its behavior.']) {
      const value = field === 'reason' ? { ...hidden, reason: content }
        : { ...documented, entries: [{ ...entry, ...(field === 'action' ? { actionRequired: true } : {}), [field]: content }] };
      errorCode(() => parseFragment(encode(value)), 'RN_FRAGMENT_TEXT');
    }
  });
  it.each(['The user_id and build_number fields remain stable.', 'Names foo__bar__baz retain their behavior.',
    'Calculate 2 * 3 * 4 before saving.', 'About ~10 to ~20 items are processed.',
    'An unmatched **marker remains literal.', 'Spaces in * literal * remain unchanged.',
    'Escaped \\*literal text\\* remains readable.', 'Escaped \\_literal text\\_ remains readable.',
    'Names foo_bar_baz remain unchanged.'])('preserves literal punctuation: %s', (reason) => {
    expect(parseFragment(encode({ ...hidden, reason }))).toEqual({ ...hidden, reason });
  });
  it.each([1, 5])('accepts %i facts and repeated text in separate objects', (count) => {
    const value = { ...documented, entries: Array.from({ length: count }, () => ({ ...entry })) };
    expect(parseFragment(encode(value))).toEqual(value);
    expect(validateSchema(value)).toBe(true);
  });
  it.each([0, 6])('rejects %i facts', (count) => errorCode(() => parseFragment(encode({ ...documented, entries: Array(count).fill(entry) })), 'RN_FRAGMENT_SCHEMA'));
  it.each(['change', 'userImpact', 'reason', 'action'])('checks normalized code point lengths for %s', (field) => {
    const minimum = field === 'action' ? 5 : 10;
    for (const length of [minimum - 1, minimum, 240, 241]) {
      const value = field === 'reason' ? { ...hidden, reason: '😀'.repeat(length) }
        : { ...documented, entries: [{ ...entry, ...(field === 'action' ? { actionRequired: true } : {}), [field]: '😀'.repeat(length) }] };
      if (length < minimum || length > 240) errorCode(() => parseFragment(encode(value)), 'RN_FRAGMENT_TEXT');
      else expect(validateSchema(parseFragment(encode(value)))).toBe(true);
    }
  });
  it('normalizes NFC and surrounding spaces without modifying source bytes', () => {
    const bytes = encode({ ...hidden, reason: `  ${'e\u0301'.repeat(10)}  ` });
    const original = bytes.slice();
    expect(parseFragment(bytes)).toEqual({ ...hidden, reason: 'é'.repeat(10) });
    expect(bytes).toEqual(original);
    errorCode(() => parseFragment(encode({ ...hidden, reason: `   ${'e\u0301'.repeat(9)}   ` })), 'RN_FRAGMENT_TEXT');
  });
  it.each(['# Heading text', '- A list item here', '1. Numbered list text', '> A quoted paragraph',
    '[link](destination)', '![image](destination)', '[reference][target]', '<b>HTML text</b>',
    'https://example.com', 'www.example.com', 'mailto:user@example.com', '```code goes here```',
    '~~~code goes here~~~', '| table | cells |', 'Use {{variable}} here', 'Use ${variable} here', 'Use {previousTag} here'])('rejects markup: %s', (reason) => {
    errorCode(() => parseFragment(encode({ ...hidden, reason })), 'RN_FRAGMENT_TEXT');
  });
  it.each(['Supports .NET 8.0 and Node.js 24.', 'Limit increased to 100 MB per file.', 'Comparisons accept x < y and y > z.'])('accepts technical prose: %s', (reason) => {
    expect(parseFragment(encode({ ...hidden, reason }))).toEqual({ ...hidden, reason });
  });
  it.each([8, 64])('accepts an ID of length %i', (length) => expect(fragmentIdFromPath(`.release-notes/fragments/${'a'.repeat(length)}.json`)).toBe('a'.repeat(length)));
  it.each(['short', 'a'.repeat(65), 'Uppercase', 'has_under', 'nested/abcdefgh'])('rejects invalid ID %s', (id) => errorCode(() => fragmentIdFromPath(`.release-notes/fragments/${id}.json`), 'RN_FRAGMENT_ID'));
});

describe('T03: path requirements', () => {
  it.each(['fragments/*', 'fragments/**', 'fragments/?', 'fragments/{a,b}', 'fragments/[ab]', 'fragments/!(a)'])('rejects a pattern directory in both entry points: %s', (directory) => {
    errorCode(() => validateFragmentProfile({ ...profile, fragmentDirectory: directory }), 'RN_PROFILE_INVALID');
    errorCode(() => fragmentIdFromPath(`${directory}/abcdefgh.json`, directory), 'RN_PROFILE_INVALID');
  });
  it('accepts a custom literal directory in both entry points', () => {
    expect(() => validateFragmentProfile({ ...profile, fragmentDirectory: 'changes/facts' })).not.toThrow();
    expect(fragmentIdFromPath('changes/facts/abcdefgh.json', 'changes/facts')).toBe('abcdefgh');
  });
  it.each([
    ['src/main.ts', 'required'], ['docs/user/start.md', 'required'], ['docs/internal.md', 'ignored'],
    ['tests/spec.ts', 'ignored'], ['VERSION', 'ignored'], ['package.json', 'review-required'],
    ['.github/workflows/release.yml', 'review-required'], ['.github/workflows/ci.yml', 'ignored'],
    ['unknown.txt', 'review-required'], ['SRC/main.ts', 'review-required'], ['src/.hidden/file', 'required'],
    ['.release-notes/fragments/abcdefgh.json', 'ignored'],
  ])('%s gives %s', (path, expected) => expect(decision(path).requirement).toBe(expected));
  it.each(['added', 'modified', 'removed'] as const)('counts %s paths', (status) => {
    expect(evaluateRequirement([{ status, path: 'src/main.ts' }], null, profile).requirement).toBe('required');
  });
  it.each([['src/main.ts', 'tests/main.ts'], ['tests/main.ts', 'src/main.ts']])('checks both rename paths', (previousPath, path) => {
    const result = evaluateRequirement([{ status: 'renamed', path, previousPath }], null, profile);
    expect(result.requirement).toBe('required');
    expect(result.paths).toHaveLength(2);
  });
  it('takes the highest requirement regardless of input order', () => {
    const changes = ['tests/spec.ts', 'unknown.txt', 'src/main.ts'].map((path) => ({ status: 'modified' as const, path }));
    expect(evaluateRequirement(changes, null, profile).requirement).toBe('required');
    expect(evaluateRequirement(changes.reverse(), null, profile).requirement).toBe('required');
  });
  it('keeps fragment paths ignored even under a catch-all rule', () => {
    expect(evaluateRequirement([{ status: 'added', path: '.release-notes/fragments/abcdefgh.json' }], null, { ...profile, required: ['**'] }).requirement).toBe('ignored');
  });
  it.each(['', '/abs', '../src', 'src/../x', 'src\\x', 'C:/x', './src/x', 'src//x', 'src/'])('rejects noncanonical paths %s', (path) => errorCode(() => decision(path), 'RN_PATH_INVALID'));
  it.each(['', '!src/**', '/src/**', '../src/**', 'src\\*', '{src,lib}/**', '@(src)/**', 'src/[ab].ts', 'src/***.ts', 'src/a**/b'])('rejects unsupported glob %s', (pattern) => {
    errorCode(() => validateFragmentProfile({ ...profile, ignored: [pattern] }), 'RN_PROFILE_INVALID');
  });
  it.each([
    ['*.ts', 'src/main.ts', 'review-required'], ['src/*.ts', 'src/deep/main.ts', 'review-required'],
    ['src/?.ts', 'src/a.ts', 'required'], ['src/?.ts', 'src/ab.ts', 'review-required'],
    ['src/**/*.ts', 'src/a.ts', 'required'], ['src/**/*.ts', 'src/deep/a.ts', 'required'],
    ['#file', '#file', 'required'],
  ])('matches %s against %s', (pattern, path, expected) => {
    expect(evaluateRequirement([{ status: 'added', path }], null, { ...profile, required: [pattern], reviewRequired: [], ignored: [] }).requirement).toBe(expected);
  });
});

describe('T04: classification and risk consistency', () => {
  const coreDecision = (id: string, risks: string[] = []): ClassificationDecision => ({
    primaryKind: { id, source: 'deterministic-fallback', reasonCode: 'test' },
    riskFlags: risks.map((id) => ({ id, source: 'rule' })), facets: [], areas: [],
    aiState: 'missing', runtimeRelease: false, installOrPackage: false,
  });
  it.each(['feature', 'bug', 'performance'])('adapts core %s decisions to path escalation', (kind) => {
    const input = coreDecision(kind);
    const before = structuredClone(input);
    const adapted = toFragmentClassification(input);
    expect(adapted).toEqual({ primaryKind: kind, riskFlags: [] });
    expect(decision('tests/a.ts', adapted).requirement).toBe('review-required');
    expect(input).toEqual(before);
  });
  it.each(['security', 'breaking-change'])('preserves core %s risk constraints', (risk) => {
    const adapted = toFragmentClassification(coreDecision('maintenance', [risk]));
    const result = decision('tests/a.ts', adapted);
    expect(result.requirement).toBe('required');
    errorCode(() => validateFragmentRequirement(parseFragment(encode(hidden)), result, adapted), 'RN_FACT_CONFLICT');
    if (risk === 'breaking-change') {
      errorCode(() => validateFragmentRequirement(parseFragment(encode(documented)), result, adapted), 'RN_FACT_CONFLICT');
    }
  });
  it('keeps missing classification distinct and copies risk IDs', () => {
    expect(toFragmentClassification(null)).toBeNull();
    expect(decision('src/a.ts', toFragmentClassification(null))).toMatchObject({ requirement: 'required', classificationState: 'missing' });
    const input = coreDecision('maintenance', ['security', 'breaking-change']);
    const adapted = toFragmentClassification(input);
    input.riskFlags.length = 0;
    expect(adapted?.riskFlags).toEqual(['security', 'breaking-change']);
    expect(decision('tests/a.ts', toFragmentClassification(coreDecision('maintenance'))).requirement).toBe('ignored');
  });
  it.each(['feature', 'bug', 'performance'])('raises %s to review-required', (primaryKind) => {
    expect(decision('tests/a.ts', { primaryKind, riskFlags: [] }).requirement).toBe('review-required');
  });
  it.each(['security', 'breaking-change'])('raises %s to required', (risk) => {
    const classification = { primaryKind: 'maintenance', riskFlags: [risk] };
    const result = decision('tests/a.ts', classification);
    expect(result.requirement).toBe('required');
    errorCode(() => validateFragmentRequirement(parseFragment(encode(hidden)), result, classification), 'RN_FACT_CONFLICT');
    errorCode(() => validateFragmentRequirement(null, result, classification), 'RN_FRAGMENT_REQUIRED');
  });
  it('requires an action for breaking changes', () => {
    const classification = { primaryKind: 'feature', riskFlags: ['breaking-change'] };
    const result = decision('src/a.ts', classification);
    errorCode(() => validateFragmentRequirement(parseFragment(encode(documented)), result, classification), 'RN_FACT_CONFLICT');
    const fragment = parseFragment(encode({ ...documented, entries: [entry, { ...entry, actionRequired: true, action: 'Update the configuration before starting.' }] }));
    expect(() => validateFragmentRequirement(fragment, result, classification)).not.toThrow();
  });
  it('allows security facts without a required user action', () => {
    const classification = { primaryKind: 'bug', riskFlags: ['security'] };
    expect(() => validateFragmentRequirement(parseFragment(encode(documented)), decision('src/a.ts', classification), classification)).not.toThrow();
  });
  it('keeps path requirements when classification is missing or lower', () => {
    expect(decision('src/a.ts')).toMatchObject({ requirement: 'required', classificationState: 'missing' });
    expect(decision('src/a.ts', { primaryKind: 'maintenance', riskFlags: [] })).toMatchObject({ requirement: 'required', classificationState: 'provided' });
  });
  it('requires a fragment for both review levels and accepts explicit declarations', () => {
    for (const path of ['src/a.ts', 'unknown.txt']) {
      errorCode(() => validateFragmentRequirement(null, decision(path), null), 'RN_FRAGMENT_REQUIRED');
      for (const value of [documented, hidden]) expect(() => validateFragmentRequirement(parseFragment(encode(value)), decision(path), null)).not.toThrow();
    }
    expect(() => validateFragmentRequirement(null, decision('tests/a.ts'), null)).not.toThrow();
    expect(() => validateFragmentRequirement(parseFragment(encode(documented)), decision('tests/a.ts'), null)).not.toThrow();
  });
});
