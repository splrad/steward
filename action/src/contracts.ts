import type { MatrixMode, MatrixScope } from '../../packages/core/src/index.js';

export const stewardOperations = [
  'version',
  'classification',
  'cleanup',
  'dco-advisory',
  'governance-preflight',
  'governance-request-copilot',
  'governance-auto-approve',
  'governance-main',
  'governance-copilot',
  'matrix',
  'release-adapter',
  'release-preflight',
  'release-status',
  'release-reconcile',
  'release-publish',
  'release-finalize',
] as const;

export type StewardOperation = typeof stewardOperations[number];

export interface StewardActionInputs {
  operation: string;
  token?: string;
  mutationToken?: string;
  eventPath?: string;
  prNumber?: string;
  headSha?: string;
  requestResult?: string;
  matrixMode?: string;
  matrixScope?: string;
  releaseAdapterCommand?: string;
  releaseContext?: string;
  releaseWorkspace?: string;
  releaseAdapterPhase?: string;
  releasePlan?: string;
  releaseAssets?: string;
  releaseOutputDirectory?: string;
  releaseFailureSummary?: string;
}

export interface StewardOperationDefinition {
  token: 'none' | 'github';
  mutationToken: boolean;
  event: boolean;
  actionsWrite: boolean;
}

export const operationDefinitions: Readonly<Record<StewardOperation, StewardOperationDefinition>> = {
  version: { token: 'none', mutationToken: false, event: false, actionsWrite: false },
  classification: { token: 'github', mutationToken: false, event: true, actionsWrite: false },
  cleanup: { token: 'github', mutationToken: false, event: true, actionsWrite: false },
  'dco-advisory': { token: 'github', mutationToken: false, event: true, actionsWrite: false },
  'governance-preflight': { token: 'github', mutationToken: false, event: true, actionsWrite: false },
  'governance-request-copilot': { token: 'github', mutationToken: true, event: true, actionsWrite: false },
  'governance-auto-approve': { token: 'github', mutationToken: true, event: true, actionsWrite: false },
  'governance-main': { token: 'github', mutationToken: false, event: true, actionsWrite: false },
  'governance-copilot': { token: 'github', mutationToken: false, event: true, actionsWrite: false },
  matrix: { token: 'github', mutationToken: false, event: true, actionsWrite: true },
  'release-adapter': { token: 'none', mutationToken: false, event: false, actionsWrite: false },
  'release-preflight': { token: 'github', mutationToken: false, event: true, actionsWrite: false },
  'release-status': { token: 'github', mutationToken: false, event: false, actionsWrite: false },
  'release-reconcile': { token: 'github', mutationToken: false, event: false, actionsWrite: false },
  'release-publish': { token: 'github', mutationToken: false, event: false, actionsWrite: false },
  'release-finalize': { token: 'github', mutationToken: false, event: true, actionsWrite: false },
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
