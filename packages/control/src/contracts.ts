import type {
  CheckRunCreate,
  CheckRunUpdate,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubPullRequestFile,
  GitHubRepositoryMetadata,
  GitHubRepositoryLabel,
} from '../../github/src/index.js';
import type {
  PublicLabelConfiguration,
  LoadedManifest,
  RepositoryFile,
} from '../../manifest/src/index.js';

export const controlPlanContractVersion = 1 as const;

export type ControlObjective = 'classification' | 'dco-advisory';
export type ControlPrincipal = 'installation';
export type ControlOperationState = 'passed' | 'pending' | 'failed' | 'action_required' | 'ignored';

export interface ControlPlanSubject {
  repository: {
    id: number;
    owner: string;
    name: string;
    defaultBranch: string;
  };
  pullRequest: {
    number: number;
    headSha: string;
  };
  manifest: {
    blobSha: string;
    configDigest: string;
  };
  platform: {
    appId: number;
    clientId: string;
    appSlug: string;
  };
}

export interface PullRequestControlContext {
  subject: ControlPlanSubject;
  pull: GitHubPullRequest;
  manifest: LoadedManifest;
  detailsUrl?: string;
}

export interface PullRequestControlRoute {
  repository: {
    id: number;
    owner: string;
    name: string;
  };
  pullRequest: {
    number: number;
    expectedHeadSha?: string;
  };
  attemptId: string;
  detailsUrl?: string;
}

export interface ClassificationLease {
  contractVersion: 1;
  checkRunId: number;
  externalId: string;
  attemptDigest: string;
  repositoryId: number;
  pullNumber: number;
  headSha: string;
  appId: number;
  appSlug: string;
}

export interface ControlOperationResult {
  operation: ControlObjective;
  state: ControlOperationState;
  summary: string;
  details?: unknown;
}

export interface ControlPlanOutcome {
  state: ControlOperationState;
  summary: string;
}

export interface ControlMutationPreconditions {
  repositoryId: number;
  defaultBranch: string;
  pullNumber: number;
  headSha: string;
  manifestBlobSha: string;
  configDigest: string;
  pullRequestDigest: string;
}

interface ControlMutationIntentBase {
  key: string;
  principal: ControlPrincipal;
}

export interface EnsureRepositoryLabelIntent extends ControlMutationIntentBase {
  type: 'repository-label.ensure';
  label: PublicLabelConfiguration;
}

export interface AddIssueLabelsIntent extends ControlMutationIntentBase {
  type: 'issue-labels.add';
  labels: string[];
  observedLabelsDigest: string;
}

export interface RemoveIssueLabelIntent extends ControlMutationIntentBase {
  type: 'issue-label.remove';
  label: string;
  observedLabelsDigest: string;
}

export interface CreateCheckRunIntent extends ControlMutationIntentBase {
  type: 'check-run.upsert';
  mode: 'create';
  checkRunId?: never;
  input: CheckRunCreate;
  observedLabelsDigest: string;
  observedCheckExternalId: string;
}

export interface UpdateCheckRunIntent extends ControlMutationIntentBase {
  type: 'check-run.upsert';
  mode: 'update';
  checkRunId: number;
  input: CheckRunUpdate;
  observedLabelsDigest: string;
  observedCheckExternalId: string;
}

export interface DeleteIssueCommentIntent extends ControlMutationIntentBase {
  type: 'issue-comment.delete';
  commentId: number;
  expectedOwnerId: number;
  expectedOwnerLogin: string;
  observedBodyDigest: string;
}

export type ControlMutationIntent =
  | EnsureRepositoryLabelIntent
  | AddIssueLabelsIntent
  | RemoveIssueLabelIntent
  | CreateCheckRunIntent
  | UpdateCheckRunIntent
  | DeleteIssueCommentIntent;

export type ControlMutation = ControlMutationIntent & {
  desiredDigest: string;
  preconditions: ControlMutationPreconditions;
};

export interface ControlPlan {
  contractVersion: typeof controlPlanContractVersion;
  planId: string;
  snapshotDigest: string;
  pullRequestDigest: string;
  objective: ControlObjective;
  subject: ControlPlanSubject;
  outcome: ControlPlanOutcome;
  mutations: ControlMutation[];
}

export interface ControlDecision {
  plan: ControlPlan;
  result: ControlOperationResult;
}

export interface ControlMutationReceipt {
  planId: string;
  key: string;
  desiredDigest: string;
  state: 'applied' | 'converged';
  resourceId?: number;
}

export interface ControlReconcileResult extends ControlDecision {
  receipts: ControlMutationReceipt[];
}

export interface ControlRuntimeIdentity {
  appId: number;
  clientId: string;
  appSlug: string;
}

export interface ControlRepositoryReadPort {
  getRepository(owner: string, repository: string): Promise<GitHubRepositoryMetadata>;
  getFile(owner: string, repository: string, path: string, ref: string): Promise<RepositoryFile>;
  getPullRequest(owner: string, repository: string, number: number): Promise<GitHubPullRequest>;
}

export interface ControlReadPort extends ControlRepositoryReadPort {
  getUser(login: string): Promise<{ id: number; login: string; type: string }>;
  listPullRequestCommits(owner: string, repository: string, number: number): Promise<GitHubCommit[]>;
  listPullRequestFiles(owner: string, repository: string, number: number): Promise<GitHubPullRequestFile[]>;
  listCommitCheckRuns(owner: string, repository: string, ref: string): Promise<GitHubCheckRun[]>;
  listIssueComments(owner: string, repository: string, number: number): Promise<GitHubIssueComment[]>;
}

export interface ControlPreconditionReadPort extends ControlRepositoryReadPort {
  listCommitCheckRuns(owner: string, repository: string, ref: string): Promise<GitHubCheckRun[]>;
  listIssueComments(owner: string, repository: string, number: number): Promise<GitHubIssueComment[]>;
}

export interface InstallationMutationPort {
  getRepositoryLabel(owner: string, repository: string, name: string): Promise<GitHubRepositoryLabel>;
  createRepositoryLabel(
    owner: string,
    repository: string,
    label: PublicLabelConfiguration,
  ): Promise<GitHubRepositoryLabel>;
  addIssueLabels(owner: string, repository: string, number: number, labels: readonly string[]): Promise<void>;
  removeIssueLabel(owner: string, repository: string, number: number, label: string): Promise<void>;
  createCheckRun(owner: string, repository: string, input: CheckRunCreate): Promise<GitHubCheckRun>;
  updateCheckRun(
    owner: string,
    repository: string,
    checkRunId: number,
    input: CheckRunUpdate,
  ): Promise<GitHubCheckRun>;
  deleteIssueComment(owner: string, repository: string, commentId: number): Promise<void>;
}

export interface ControlMutationPorts {
  installation?: InstallationMutationPort;
  preconditions?: ControlPreconditionReadPort;
}
