import type { MatrixMode, MatrixScope } from '../../packages/core/src/index.js';

export const stewardOperations = [
  'version',
  'governance-request-copilot',
  'governance-auto-approve',
  'governance-main',
  'governance-copilot',
  'matrix',
] as const;

export type StewardOperation = typeof stewardOperations[number];

export interface StewardActionInputs {
  operation: string;
  token?: string;
  eventPath?: string;
  prNumber?: string;
  headSha?: string;
  requestResult?: string;
  matrixMode?: string;
  matrixScope?: string;
}

export interface StewardOperationDefinition {
  token: 'none' | 'github';
  event: boolean;
  actionsWrite: boolean;
}

export const operationDefinitions: Readonly<Record<StewardOperation, StewardOperationDefinition>> = {
  version: { token: 'none', event: false, actionsWrite: false },
  'governance-request-copilot': { token: 'github', event: true, actionsWrite: false },
  'governance-auto-approve': { token: 'github', event: true, actionsWrite: false },
  'governance-main': { token: 'github', event: true, actionsWrite: false },
  'governance-copilot': { token: 'github', event: true, actionsWrite: false },
  matrix: { token: 'github', event: true, actionsWrite: true },
};

export function parseOperation(value: string): StewardOperation {
  const operation = value.trim();
  if ((stewardOperations as readonly string[]).includes(operation)) return operation as StewardOperation;
  throw new Error(`Unsupported Steward operation: ${operation}`);
}

export function parseMatrixMode(value: string | undefined): MatrixMode {
  const mode = value?.trim() || 'enforce';
  if (mode === 'observe' || mode === 'repair' || mode === 'enforce') return mode;
  throw new Error(`Unsupported Matrix mode: ${mode}`);
}

export function parseMatrixScope(value: string | undefined, eventName: string, reviewSignal = false): MatrixScope {
  const scope = value?.trim() || 'auto';
  if (scope === 'full' || scope === 'gate-only') return scope;
  if (scope === 'auto') return eventName === 'repository_dispatch' || reviewSignal ? 'gate-only' : 'full';
  throw new Error(`Unsupported Matrix scope: ${scope}`);
}
