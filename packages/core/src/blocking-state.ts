import { decodeBase64Utf8, encodeBase64Utf8 } from '../../manifest/src/encoding.js';
import { uniqueHumanLogins } from './identity.js';

export const blockingFailuresMarker = '<!-- workflow:pr-blocking-failures -->';

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
  const encoded = String(body ?? '').match(blockingFailuresStatePattern)?.[1];
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
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
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
