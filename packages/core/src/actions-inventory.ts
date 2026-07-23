export type StewardActionsWorkflowSurface =
  | 'platform-direct'
  | 'platform-reusable'
  | 'legacy-consumer-template';

export type StewardActionsActorModel =
  | 'event-originating-actor'
  | 'inherited-caller-context'
  | 'github-actor-with-bot-suffix-denied';

export interface StewardActionsTrigger {
  readonly event: string;
  readonly actions?: readonly string[];
  readonly branches?: readonly string[];
  readonly branchesIgnore?: readonly string[];
  readonly paths?: readonly string[];
  readonly workflowNames?: readonly string[];
  readonly inputs?: readonly string[];
}

export interface StewardActionsWorkflowInventoryEntry {
  readonly path: string;
  readonly surface: StewardActionsWorkflowSurface;
  readonly generatedPath?: string;
  readonly actorModel: StewardActionsActorModel;
  readonly actorGuards: readonly string[];
  readonly triggers: readonly StewardActionsTrigger[];
  readonly uses: readonly string[];
  readonly credentialVariables: readonly string[];
  readonly credentialSecrets: readonly string[];
  readonly mutationPrincipals: readonly string[];
  readonly executesRepositoryCode: boolean;
}

const appToken = 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1';
const checkout = 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0';
const setupNode = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const pullRequestAction = 'splrad/steward/action@a77408f925666d273efc3250caec8cabe174eb15';
const automationAction = 'splrad/steward/action@3a8a41035db1df7795a7546d9708a42d15617104';
const cleanupAction = 'splrad/steward/action@c0eb1530e2fb3062749c879671514370bae49f37';
const releaseAction = 'splrad/steward/action@6e33424e7fb18100145845b49e8ccf2c90d504e0';

const executionPolicyActors = {
  repositoryRoles: ['read', 'triage', 'write', 'maintain', 'admin'],
  integrations: [
    { kind: 'github-app', id: 4243096, slug: 'splrad-steward' },
    { kind: 'github-system', slug: 'dependabot' },
    { kind: 'github-system', slug: 'copilot' },
    { kind: 'github-system', slug: 'github-actions' },
  ],
} as const;

const platformTokenCredentials = {
  credentialVariables: [] as const,
  credentialSecrets: [] as const,
  mutationPrincipals: ['steward-app-installation-token'] as const,
};

const reusable = (
  path: string,
  inputs: readonly string[],
  secrets: readonly string[],
  uses: readonly string[],
  mutationPrincipals: readonly string[] = platformTokenCredentials.mutationPrincipals,
  executesRepositoryCode = false,
): StewardActionsWorkflowInventoryEntry => ({
  path,
  surface: 'platform-reusable',
  actorModel: 'inherited-caller-context',
  actorGuards: [],
  triggers: [{ event: 'workflow_call', inputs }],
  uses,
  credentialVariables: [],
  credentialSecrets: secrets,
  mutationPrincipals,
  executesRepositoryCode,
});

const legacy = (
  name: string,
  triggers: readonly StewardActionsTrigger[],
  options: {
    readonly actorModel?: StewardActionsActorModel;
    readonly actorGuards?: readonly string[];
    readonly credentialVariables?: readonly string[];
    readonly credentialSecrets?: readonly string[];
    readonly mutationPrincipals?: readonly string[];
  } = {},
): StewardActionsWorkflowInventoryEntry => ({
  path: `templates/thin-workflows/${name}.yml`,
  surface: 'legacy-consumer-template',
  generatedPath: `.github/workflows/${name}.yml`,
  actorModel: options.actorModel ?? 'event-originating-actor',
  actorGuards: options.actorGuards ?? [],
  triggers,
  uses: [`splrad/steward/.github/workflows/${name}.yml@__STEWARD_SHA__`],
  credentialVariables: options.credentialVariables ?? [],
  credentialSecrets: options.credentialSecrets ?? [],
  mutationPrincipals: options.mutationPrincipals ?? [],
  executesRepositoryCode: false,
});

/**
 * Versioned semantic inventory of every Steward-owned workflow source.
 *
 * This intentionally records the migration-only Actions-first callers as
 * legacy surfaces. They remain executable evidence until central App-first
 * cutover, but they are not the target consumer footprint.
 */
export const STEWARD_ACTIONS_SOURCE_INVENTORY = {
  schemaVersion: 1,
  inventoryVersion: 's66-actions-v2',
  workflowRoots: ['.github/workflows', 'templates/thin-workflows'],
  generatedTemplateRoot: 'packages/cli/dist/templates/thin-workflows',
  actionEntrypoint: {
    path: 'action/action.yml',
    using: 'node24',
    main: 'dist/index.js',
  },
  dependencyUpdateEcosystems: ['github-actions', 'npm'],
  executionPolicyActors,
  // Full-source digests close the intentionally summarized projection above:
  // permissions, job guards, runners, environments, run scripts, OIDC, input
  // schemas, defaults, downloads, and every other YAML field are all bound.
  sourceDigests: {
    '.github/dependabot.yml': 'd1a94085e052eadf54a18ed110a856653e05db08e57142563fd8d9e87fd3f351',
    'action/action.yml': 'aa360c1d26095ee09f34e65141133c0797ee7daf0294645337ce0765d9a23de1',
    '.github/workflows/ci.yml': 'ba70c32cb39e58e4cf7dbfdd91d693837562cfc329b26fcb872d088097958229',
    '.github/workflows/dco-advisory.yml': 'a78f158cfbc8c2ff7fd8c676153121b0780fb9950983bb8b21acbbe22d5ea954',
    '.github/workflows/deploy-relay.yml': '508e6285293bdc860e02a1e9162bcf113d53aff92fa4b843a81c8ca77890a397',
    '.github/workflows/pr-automation.yml': 'f7e6834769114bbacae1acceea3f56ad23477aabff76a9e89c2453c7c12df7cf',
    '.github/workflows/pr-classification.yml': 'b431b1f18767cfae88c28e2683a8633ab99046e8d9b1dc3c0a27f7e7dc293e93',
    '.github/workflows/pr-cleanup.yml': 'debdc11245c488d30378090e1da0c5ceba89f79774b7317aa920b9b0f1d6008f',
    '.github/workflows/pr-governance.yml': '226fc7e81d645ca3f2c8666f067a03b6af7921f9aae936d1c91805c41b6181b1',
    '.github/workflows/pr-review-signal.yml': '956e9cd68526f5e395056709d590b20fc41412df0336f40a1e1b64591ed74af6',
    '.github/workflows/pr-validation-matrix.yml': '5017574859ef145bcc55b2b71e6456b5e9de4c383a9c7736f36382d893752c53',
    '.github/workflows/release.yml': 'f85cf5c879d34cbcc08412ba7061e74b5153ef4182fd068b26617c750e4bf09f',
    'templates/thin-workflows/dco-advisory.yml': '0fddc2d8c7eb3c9fdb5417c992466fa906eac25a164378baa6b5495d6830735c',
    'templates/thin-workflows/pr-automation.yml': '7c5d83c6a70be64de5b6309511c5e40a617db85fcc79a3870f786136bad496fe',
    'templates/thin-workflows/pr-classification.yml': '227e2d82e64a529f6b013039e28d4c627f8681e84ce020ba7f76072f4a31108a',
    'templates/thin-workflows/pr-cleanup.yml': '82fb774a806cf0dcdb9123eceb3aa9e064281b7b30c500c7e5c21bd38ee625fe',
    'templates/thin-workflows/pr-governance.yml': 'fb91d7d05dcb8279113b85379a03bee2dc52292e624bac774e28532fc49405a6',
    'templates/thin-workflows/pr-review-signal.yml': '070b1c5649ec1aa805461d4703997bd80905df1a8d8676067f838cc813d73ee7',
    'templates/thin-workflows/pr-validation-matrix.yml': 'eb07dc54e75c8e1c5843593d85a601f34d18a11495efe5350bd9ae2a9925d70e',
    'templates/thin-workflows/release.yml': '7cf4ac5025a9672546bafa0a3e0df96578ffb8d89e3e7484d3f13f5c33488899',
  },
  workflows: [
    {
      path: '.github/workflows/ci.yml',
      surface: 'platform-direct',
      actorModel: 'event-originating-actor',
      actorGuards: [],
      triggers: [
        { event: 'pull_request' },
        { event: 'push', branches: ['main'] },
        { event: 'workflow_dispatch' },
      ],
      uses: [checkout, setupNode],
      credentialVariables: [],
      credentialSecrets: [],
      mutationPrincipals: ['github-token-read-only'],
      executesRepositoryCode: true,
    },
    {
      path: '.github/workflows/deploy-relay.yml',
      surface: 'platform-direct',
      actorModel: 'event-originating-actor',
      actorGuards: [],
      triggers: [{ event: 'workflow_dispatch' }],
      uses: [checkout, setupNode],
      credentialVariables: [],
      credentialSecrets: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
      mutationPrincipals: ['cloudflare-deployment-token', 'github-token-read-only'],
      executesRepositoryCode: true,
    },
    reusable(
      '.github/workflows/dco-advisory.yml',
      ['app_client_id', 'head_sha', 'pr_number'],
      ['app_private_key'],
      [appToken, pullRequestAction],
    ),
    reusable(
      '.github/workflows/pr-automation.yml',
      ['app_client_id', 'head_sha', 'source_branch'],
      ['app_private_key'],
      [appToken, automationAction],
    ),
    reusable(
      '.github/workflows/pr-classification.yml',
      ['app_client_id', 'head_sha', 'pr_number'],
      ['app_private_key'],
      [appToken, pullRequestAction],
    ),
    reusable(
      '.github/workflows/pr-cleanup.yml',
      ['app_client_id', 'head_sha', 'pr_number'],
      ['app_private_key'],
      [appToken, cleanupAction],
    ),
    reusable(
      '.github/workflows/pr-governance.yml',
      ['app_client_id', 'governance_scope', 'head_sha', 'pr_number'],
      ['app_private_key', 'copilot_review_request_token', 'core_auto_approval_token'],
      [appToken, pullRequestAction],
      [
        'copilot-entitled-human-token',
        'legacy-auto-approval-human-token',
        'steward-app-installation-token',
      ],
    ),
    reusable(
      '.github/workflows/pr-review-signal.yml',
      ['head_sha', 'pr_number', 'source_action', 'source_event'],
      [],
      [],
      ['github-token-read-only'],
    ),
    reusable(
      '.github/workflows/pr-validation-matrix.yml',
      ['app_client_id', 'head_sha', 'mode', 'pr_number', 'scope'],
      ['app_private_key'],
      [appToken, pullRequestAction],
    ),
    reusable(
      '.github/workflows/release.yml',
      ['app_client_id', 'pr_number'],
      ['app_private_key'],
      [checkout, appToken, releaseAction],
      ['steward-app-installation-token'],
      true,
    ),
    legacy(
      'dco-advisory',
      [
        {
          event: 'pull_request_target',
          actions: ['opened', 'ready_for_review', 'reopened', 'synchronize'],
        },
        { event: 'workflow_dispatch', inputs: ['head_sha', 'pr_number'] },
      ],
      {
        credentialVariables: ['WORKFLOW_AUTOMATION_APP_CLIENT_ID'],
        credentialSecrets: ['WORKFLOW_AUTOMATION_APP_PRIVATE_KEY'],
        mutationPrincipals: ['steward-app-installation-token'],
      },
    ),
    legacy(
      'pr-automation',
      [{ event: 'push', branchesIgnore: ['steward/init'] }],
      {
        actorModel: 'github-actor-with-bot-suffix-denied',
        actorGuards: ["!endsWith(github.actor, '[bot]')"],
        credentialVariables: ['WORKFLOW_AUTOMATION_APP_CLIENT_ID'],
        credentialSecrets: ['WORKFLOW_AUTOMATION_APP_PRIVATE_KEY'],
        mutationPrincipals: ['steward-app-installation-token'],
      },
    ),
    legacy(
      'pr-classification',
      [
        {
          event: 'pull_request_target',
          actions: ['edited', 'opened', 'ready_for_review', 'reopened', 'synchronize'],
        },
        { event: 'workflow_dispatch', inputs: ['head_sha', 'pr_number'] },
      ],
      {
        credentialVariables: ['WORKFLOW_AUTOMATION_APP_CLIENT_ID'],
        credentialSecrets: ['WORKFLOW_AUTOMATION_APP_PRIVATE_KEY'],
        mutationPrincipals: ['steward-app-installation-token'],
      },
    ),
    legacy(
      'pr-cleanup',
      [{ event: 'pull_request_target', actions: ['closed'] }],
      {
        credentialVariables: ['WORKFLOW_AUTOMATION_APP_CLIENT_ID'],
        credentialSecrets: ['WORKFLOW_AUTOMATION_APP_PRIVATE_KEY'],
        mutationPrincipals: ['steward-app-installation-token'],
      },
    ),
    legacy(
      'pr-governance',
      [
        {
          event: 'pull_request_target',
          actions: ['opened', 'ready_for_review', 'reopened', 'synchronize'],
        },
        {
          event: 'workflow_dispatch',
          inputs: ['governance_scope', 'head_sha', 'pr_number'],
        },
      ],
      {
        credentialVariables: ['WORKFLOW_AUTOMATION_APP_CLIENT_ID'],
        credentialSecrets: [
          'COPILOT_REVIEW_REQUEST_TOKEN',
          'CORE_AUTO_APPROVAL_TOKEN',
          'WORKFLOW_AUTOMATION_APP_PRIVATE_KEY',
        ],
        mutationPrincipals: [
          'copilot-entitled-human-token',
          'legacy-auto-approval-human-token',
          'steward-app-installation-token',
        ],
      },
    ),
    legacy(
      'pr-review-signal',
      [{ event: 'pull_request', actions: ['review_request_removed', 'review_requested'] }],
      { mutationPrincipals: ['github-token-read-only'] },
    ),
    legacy(
      'pr-validation-matrix',
      [
        {
          event: 'check_run',
          actions: ['completed', 'rerequested'],
        },
        {
          event: 'pull_request_target',
          actions: ['edited', 'labeled', 'opened', 'ready_for_review', 'reopened', 'synchronize', 'unlabeled'],
        },
        {
          event: 'repository_dispatch',
          actions: ['pr-review-state-changed', 'pr-review-thread-resolved'],
        },
        {
          event: 'workflow_dispatch',
          inputs: ['head_sha', 'mode', 'pr_number', 'scope'],
        },
        {
          event: 'workflow_run',
          actions: ['completed'],
          workflowNames: ['DCO Sign-off Advisory', 'PR Classification', 'PR Governance', 'PR Review Signal'],
        },
      ],
      {
        credentialVariables: ['WORKFLOW_AUTOMATION_APP_CLIENT_ID'],
        credentialSecrets: ['WORKFLOW_AUTOMATION_APP_PRIVATE_KEY'],
        mutationPrincipals: ['steward-app-installation-token'],
      },
    ),
    legacy(
      'release',
      [
        { event: 'pull_request_target', actions: ['closed'] },
        { event: 'workflow_dispatch', inputs: ['pr_number'] },
      ],
      {
        credentialVariables: ['WORKFLOW_AUTOMATION_APP_CLIENT_ID'],
        credentialSecrets: ['WORKFLOW_AUTOMATION_APP_PRIVATE_KEY'],
        mutationPrincipals: ['steward-app-installation-token'],
      },
    ),
  ] satisfies readonly StewardActionsWorkflowInventoryEntry[],
  dormantSignalEdges: [
    {
      producer: 'legacy-relay',
      event: 'repository_dispatch:pr-review-thread-resolved',
      consumer: 'templates/thin-workflows/pr-validation-matrix.yml',
      status: 'no-current-producer',
    },
    {
      producer: 'legacy-review-signal-contract',
      event: 'pull_request_review_thread:resolved|unresolved',
      consumer: '.github/workflows/pr-review-signal.yml',
      status: 'no-current-thin-caller',
    },
  ],
} as const;

export const STEWARD_ACTIONS_GENERAL_POLICY = {
  enabledRepositories: 'all',
  allowedActions: 'selected',
  shaPinningRequired: true,
  defaultWorkflowPermissions: 'read',
  canApprovePullRequestReviews: false,
  selectedActions: {
    githubOwnedAllowed: true,
    verifiedAllowed: false,
    patternsAllowed: [
      'splrad/steward/.github/workflows/*@*',
      'splrad/steward/action@*',
    ],
  },
  reusableWorkflowPinning: 'complete-sha-enforced-by-source-verifier',
  remoteActionOriginVerification: 'required',
} as const;

/**
 * Semantic policy blueprint for the public-preview UI. GitHub does not expose
 * a stable API representation, so the owner-signed observation binds this
 * digest rather than a private endpoint response.
 */
export const STEWARD_ACTIONS_EXECUTION_POLICIES = [
  {
    name: 'SPLRAD Workflow Execution',
    target: 'organization-all-repositories',
    allowedEvents: [
      'check_run',
      'pull_request',
      'pull_request_target',
      'push',
      'repository_dispatch',
      'workflow_call',
      'workflow_dispatch',
      'workflow_run',
    ],
    allowedActors: executionPolicyActors,
  },
] as const;

// Updated only through a reviewed contract revision. These are fixed-layout
// JSON digests: reordering a contract set is intentionally a versioned change,
// while sourceDigests make every underlying YAML byte independently explicit.
export const STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST =
  'd7204f8749dc0eab6a37c501406a7d915f32a63230bcf0e77a61a288cbde3c26' as const;
export const STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST =
  'c7b0e1a932722b25951c1e4782673d1f04deac930b84a2d7fd44d8dfad1e2ef7' as const;
