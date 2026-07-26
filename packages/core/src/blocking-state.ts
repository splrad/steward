import { decodeBase64Utf8, encodeBase64Utf8 } from '../../manifest/src/encoding.js';
import { uniqueHumanLogins } from './identity.js';

export const blockingFailuresMarker = '<!-- workflow:pr-blocking-failures -->';
export const blockingStateWriterVersion = 1;
export const blockingStateMaximumCanonicalBytes = 32_768;

export interface BlockingFailureInput {
  source?: unknown;
  title?: unknown;
  handlers?: readonly unknown[];
  details?: readonly unknown[];
}

export interface BlockingFailure {
  source: string;
  title: string;
  handlers: string[];
  details: string[];
}

export interface BlockingState {
  head: string;
  failures: BlockingFailureInput[];
}

function failureRecord(failure: unknown): BlockingFailureInput {
  return failure !== null && typeof failure === 'object' ? failure as BlockingFailureInput : {};
}

function failureSource(failure: unknown): string {
  return String(failureRecord(failure).source ?? '');
}

const blockingFailuresStatePattern = /<!--\s*workflow:pr-blocking-failures-state:([A-Za-z0-9+/=_-]+)\s*-->/;
const blockingFailuresStateV1Pattern = /<!-- workflow:pr-blocking-failures-state:v1:([A-Za-z0-9+/]+={0,2}) -->/;
const blockingSourceOrder = [
  'main-authorization',
  'copilot-review:blocking-comments',
  'copilot-review:comment-protocol',
  'copilot-review:request-failed',
  'copilot-review:passing-conclusion',
  'copilot-review',
] as const;

export function encodeBlockingState(state: BlockingState): string {
  return encodeBase64Utf8(JSON.stringify(state));
}

export function decodeBlockingState(body: unknown): BlockingState | null {
  const text = String(body ?? '');
  const current = text.match(blockingFailuresStateV1Pattern)?.[1];
  if (current) {
    try {
      const parsed = JSON.parse(decodeBase64Utf8(current)) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const candidate = parsed as {
        version?: unknown;
        head?: unknown;
        failures?: unknown;
      };
      if (candidate.version !== blockingStateWriterVersion
        || !Array.isArray(candidate.failures)) return null;
      const state = canonicalBlockingState({
        head: candidate.head as string,
        failures: candidate.failures as BlockingFailureInput[],
      });
      const canonical = JSON.stringify({
        version: blockingStateWriterVersion,
        head: state.head,
        failures: state.failures,
      });
      if (new TextEncoder().encode(canonical).byteLength > blockingStateMaximumCanonicalBytes
        || encodeBase64Utf8(canonical) !== current) return null;
      return state;
    } catch {
      return null;
    }
  }

  const encoded = text.match(blockingFailuresStatePattern)?.[1];
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(decodeBase64Utf8(encoded, {
      allowUrlSafe: true,
      allowUnpadded: true,
    })) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as { head?: unknown; failures?: unknown };
    if (!Array.isArray(candidate.failures)) return null;
    return { head: String(candidate.head ?? ''), failures: candidate.failures as BlockingFailureInput[] };
  } catch {
    return null;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function strictBlockingFailure(input: BlockingFailureInput): BlockingFailure {
  if (input === null || typeof input !== 'object'
    || typeof input.source !== 'string' || !input.source.trim()
    || typeof input.title !== 'string' || !input.title.trim()
    || (input.handlers !== undefined && !Array.isArray(input.handlers))
    || (input.details !== undefined && !Array.isArray(input.details))) {
    throw new TypeError('Blocking state contains a malformed failure');
  }
  const normalized = normalizeBlockingFailure(input);
  return {
    source: normalized.source.trim(),
    title: normalized.title.trim(),
    handlers: [...new Set(normalized.handlers)].sort(compareText),
    details: [...new Set(normalized.details)].sort(compareText),
  };
}

function canonicalBlockingState(state: BlockingState): {
  head: string;
  failures: BlockingFailure[];
} {
  const head = String(state?.head ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(head) || !Array.isArray(state?.failures)) {
    throw new TypeError('Blocking state requires a valid head SHA and failures');
  }
  return {
    head,
    failures: orderedBlockingFailures(state.failures.map(strictBlockingFailure)),
  };
}

export function writeBlockingState(state: BlockingState): string {
  const canonicalState = canonicalBlockingState(state);
  const canonical = JSON.stringify({
    version: blockingStateWriterVersion,
    head: canonicalState.head,
    failures: canonicalState.failures,
  });
  const byteLength = new TextEncoder().encode(canonical).byteLength;
  if (byteLength > blockingStateMaximumCanonicalBytes) {
    throw new RangeError('Blocking state exceeds the canonical byte limit');
  }
  return `<!-- workflow:pr-blocking-failures-state:v1:${encodeBase64Utf8(canonical)} -->`;
}

export function normalizeBlockingFailure(
  input: BlockingFailureInput | null | undefined,
  botLogins: readonly unknown[] = [],
): BlockingFailure {
  const failure = failureRecord(input);
  return {
    source: String(failure.source ?? ''),
    title: String(failure.title ?? ''),
    handlers: uniqueHumanLogins(Array.isArray(failure.handlers) ? failure.handlers : [], { botLogins }),
    details: Array.isArray(failure.details)
      ? failure.details.map((detail) => String(detail ?? '').trim()).filter(Boolean)
      : [],
  };
}

export function orderedBlockingFailures<T extends BlockingFailureInput>(
  failures: readonly T[],
): T[] {
  return [...failures].sort((left, right) => {
    const leftIndex = blockingSourceOrder.indexOf(failureSource(left) as typeof blockingSourceOrder[number]);
    const rightIndex = blockingSourceOrder.indexOf(failureSource(right) as typeof blockingSourceOrder[number]);
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex)
      || compareText(failureSource(left), failureSource(right))
      || compareText(String(failureRecord(left).title ?? ''), String(failureRecord(right).title ?? ''))
      || compareText(JSON.stringify(left), JSON.stringify(right));
  });
}

export function nextBlockingFailuresState(
  existing: BlockingState | null,
  currentHead: string,
  input: {
    sourcePrefix: string;
    failures: readonly BlockingFailureInput[];
    botLogins?: readonly unknown[];
  },
): BlockingState {
  const state: BlockingState = existing?.head === currentHead && Array.isArray(existing.failures)
    ? { head: currentHead, failures: [...existing.failures] }
    : { head: currentHead, failures: [] };
  state.failures = state.failures.filter((failure) => {
    const source = failureSource(failure);
    return source !== input.sourcePrefix && !source.startsWith(`${input.sourcePrefix}:`);
  });
  state.failures.push(...input.failures.map((failure) => normalizeBlockingFailure(
    failure,
    input.botLogins,
  )));
  return state;
}
