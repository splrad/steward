import { describe, expect, it } from 'vitest';
import {
  GitHubApiError,
  GitHubOrganizationReadClient,
  type GitHubOrganizationContractInput,
  type GitHubRequest,
  type GitHubTransport,
} from '../packages/github/src/index.js';

const observedAt = '2026-07-23T00:00:00.000Z';

interface MockTransport {
  readonly transport: GitHubTransport;
  readonly requests: GitHubRequest[];
}

function mockTransport(handler: (request: GitHubRequest) => unknown): MockTransport {
  const requests: GitHubRequest[] = [];
  return {
    requests,
    transport: {
      restApiVersion: '2026-03-10',
      async request<T>(request: GitHubRequest): Promise<T> {
        requests.push(structuredClone(request));
        const result = handler(request);
        if (result instanceof Error) throw result;
        return result as T;
      },
    },
  };
}

function propertySchema(): unknown[] {
  const definitions = [
    ['steward_state', 'unmanaged', ['unmanaged', 'bootstrapping', 'active', 'paused']],
    ['steward_ring', 'production', ['canary', 'production']],
    ['governance_tier', 'solo', ['solo', 'reviewed']],
    ['ci_profile', 'none', ['none', 'codeql']],
  ] as const;
  return definitions.map(([name, defaultValue, allowedValues]) => ({
    property_name: name,
    source_type: 'organization',
    value_type: 'single_select',
    required: true,
    default_value: defaultValue,
    allowed_values: allowedValues,
    values_editable_by: 'org_actors',
    require_explicit_values: false,
  }));
}

function installation(selection: 'all' | 'selected' = 'all'): Record<string, unknown> {
  return {
    id: 9,
    app_id: 4243096,
    app_slug: 'splrad-steward',
    client_id: 'Iv23liuSr0qd4WLJdZhH',
    account: { login: 'splrad' },
    repository_selection: selection,
    suspended_at: null,
    permissions: {
      actions: 'write', checks: 'write', contents: 'write', issues: 'write', members: 'read',
      merge_queues: 'write', metadata: 'read', organization_custom_properties: 'read',
      pull_requests: 'write', statuses: 'write',
    },
    events: ['installation', 'pull_request', 'pull_request_review'],
  };
}

const input = {
  organization: 'splrad',
  owner: 'splrad',
  repository: 'example',
  repositoryId: 7,
  defaultBranch: 'main',
  maintainerTeamSlug: 'maintainers',
  appId: 4243096,
  appSlug: 'splrad-steward',
  appClientId: 'Iv23liuSr0qd4WLJdZhH',
} as const;

describe('GitHub organization contract reader', () => {
  it('reads organization, repository, App, and effective-rule facts without mutations', async () => {
    const repository = mockTransport((request) => {
      if (request.path.endsWith('/properties/values')) return [
        { property_name: 'steward_state', value: 'active' },
        { property_name: 'steward_ring', value: 'canary' },
        { property_name: 'governance_tier', value: 'solo' },
        { property_name: 'ci_profile', value: 'none' },
      ];
      if (request.path.endsWith('/rulesets')) return [{
        id: 11,
        name: 'Base Safety',
        source_type: 'Organization',
        source: 'splrad',
        enforcement: 'active',
      }];
      if (request.path === '/orgs/splrad/rulesets') return [{
        id: 11,
        name: 'Base Safety',
        source_type: 'Organization',
        source: 'splrad',
        enforcement: 'active',
      }];
      if (request.path === '/orgs/splrad/rulesets/11') return {
        id: 11,
        name: 'Base Safety',
        target: 'branch',
        enforcement: 'active',
        source_type: 'Organization',
        source: 'splrad',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [{ type: 'deletion' }],
      };
      if (request.path.endsWith('/rules/branches/main')) return [{
        type: 'deletion',
        ruleset_id: 11,
        ruleset_source_type: 'Organization',
        ruleset_source: 'splrad',
      }];
      if (request.path === '/repos/splrad/example/actions/permissions') return {
        enabled: true, allowed_actions: 'selected', sha_pinning_required: true,
      };
      throw new Error(`Unexpected repository request: ${request.path}`);
    });
    const organization = mockTransport((request) => {
      if (request.path.endsWith('/properties/schema')) return propertySchema();
      if (request.path === '/orgs/splrad/rulesets') return [{
        id: 11,
        name: 'Base Safety',
        source_type: 'Organization',
        source: 'splrad',
        enforcement: 'active',
      }];
      if (request.path === '/orgs/splrad/rulesets/11') return {
        id: 11,
        name: 'Base Safety',
        target: 'branch',
        enforcement: 'active',
        source_type: 'Organization',
        source: 'splrad',
        bypass_actors: [],
        conditions: {
          ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
          repository_name: { include: ['~ALL'], exclude: [] },
        },
        rules: [{ type: 'deletion' }],
      };
      if (request.path.endsWith('/teams/maintainers')) return { id: 5, slug: 'maintainers' };
      if (request.path.endsWith('/teams/maintainers/members')) return [{ login: 'axiomoth' }];
      if (request.path === '/repos/splrad/example') return { id: 7, full_name: 'splrad/example' };
      if (request.path.endsWith('/teams/maintainers/repos/splrad/example')) return {
        role_name: 'maintain',
        permissions: { admin: false, maintain: true, push: true, triage: true, pull: true },
      };
      if (request.path === '/orgs/splrad/actions/permissions') return {
        enabled_repositories: 'all', allowed_actions: 'selected', sha_pinning_required: true,
      };
      if (request.path === '/orgs/splrad/actions/permissions/workflow') return {
        default_workflow_permissions: 'read', can_approve_pull_request_reviews: false,
      };
      if (request.path === '/orgs/splrad/actions/permissions/selected-actions') return {
        github_owned_allowed: true, verified_allowed: false, patterns_allowed: ['splrad/*'],
      };
      throw new Error(`Unexpected organization request: ${request.path}`);
    });
    const appJwt = mockTransport((request) => {
      if (request.path === '/repos/splrad/example/installation') return installation();
      throw new Error(`Unexpected App request: ${request.path}`);
    });
    const executionProtections = {
      status: 'known' as const,
      value: {
        schemaVersion: 1 as const,
        organization: 'splrad',
        repositoryId: 7,
        repositoryFullName: 'splrad/example',
        propertyDigest: '4d2a9cc3d6fda6383a276918b06ba3481c6c4894ed4e1ea9ad3a0a0eb2f5b56b',
        contractVersion: 's66-v1',
        contractDigest: '2c61b60caaf401c78e6e717165de8f7317f3cc94ef15e4c949fbb164013bb537',
        attestorLogin: 'organization-owner',
        mode: 'evaluate' as const,
        policyCount: 2,
      },
      evidence: {
        source: 'github-ui-attestation' as const,
        endpoint: 'https://github.com/organizations/splrad/settings/actions/policies',
        observedAt,
      },
    };
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: repository.transport,
      organizationTransport: organization.transport,
      appJwtTransport: appJwt.transport,
      actionsExecutionProtections: executionProtections,
      observedAt: () => observedAt,
    });

    const snapshot = await reader.inspect(input);

    expect(snapshot.propertySchema).toMatchObject({ status: 'known' });
    expect(snapshot.repositoryProperties).toMatchObject({ status: 'known' });
    expect(snapshot.organizationRulesets).toMatchObject({
      status: 'known',
      value: [{ name: 'Base Safety', sourceType: 'Organization' }],
      evidence: {
        endpoint: '/orgs/splrad/rulesets',
        relatedEndpoints: ['/orgs/splrad/rulesets/11'],
      },
    });
    expect(snapshot.applicableRulesets).toMatchObject({
      status: 'known',
      value: [{
        id: 11,
        name: 'Base Safety',
        sourceType: 'Organization',
        source: 'splrad',
        enforcement: 'active',
      }],
    });
    expect(snapshot.effectiveRules).toMatchObject({
      status: 'known', value: [{ type: 'deletion', rulesetSourceType: 'Organization' }],
    });
    expect(snapshot.maintainerTeamAccess).toMatchObject({
      status: 'known', value: { teamId: 5, roleName: 'maintain', permissions: { maintain: true } },
    });
    expect(snapshot.maintainerTeamMembers).toMatchObject({
      status: 'known', value: ['axiomoth'],
    });
    expect(snapshot.appInstallation).toMatchObject({
      status: 'known', value: { appId: 4243096, repositoryAccess: { status: 'known', value: true } },
    });
    expect(snapshot.actions.organization).toMatchObject({
      status: 'known', value: { allowedActions: 'selected', shaPinningRequired: true },
    });
    expect(snapshot.actions.executionProtections).toEqual(executionProtections);
    expect(repository.requests.find((request) => request.path.endsWith('/rulesets'))?.query)
      .toMatchObject({ includes_parents: true });
    expect(organization.requests.some((request) => request.path === '/orgs/splrad/rulesets/11')).toBe(true);
    expect(organization.requests.find((request) => request.path.includes('/teams/maintainers/repos'))?.accept)
      .toBe('application/vnd.github.v3.repository+json');
    expect(repository.requests.some((request) => request.path === '/repos/splrad/example/actions/permissions'))
      .toBe(true);
    expect(organization.requests.some((request) => request.path.startsWith('/repos/splrad/example/actions/')))
      .toBe(false);
    expect([...repository.requests, ...organization.requests, ...appJwt.requests]
      .every((request) => !request.method || request.method === 'GET')).toBe(true);
  });

  it('does not request details for organization rulesets outside the requested contract names', async () => {
    const organization = mockTransport((request) => {
      if (request.path === '/orgs/splrad/rulesets') return [
        {
          id: 11,
          name: 'Base Safety',
          source_type: 'Organization',
          source: 'splrad',
          enforcement: 'active',
        },
        {
          id: 12,
          name: 'Unrelated Organization Policy',
          source_type: 'Organization',
          source: 'splrad',
          enforcement: 'active',
        },
      ];
      if (request.path === '/orgs/splrad/rulesets/11') return {
        id: 11,
        name: 'Base Safety',
        target: 'branch',
        enforcement: 'active',
        source_type: 'Organization',
        source: 'splrad',
        bypass_actors: [],
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [{ type: 'deletion' }],
      };
      throw new Error(`Unexpected organization request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: organization.transport,
      organizationTransport: organization.transport,
      observedAt: () => observedAt,
    });

    const result = await reader.listOrganizationRulesets('splrad', observedAt, ['Base Safety']);

    expect(result).toMatchObject({
      status: 'known',
      value: [{ id: 11, name: 'Base Safety' }],
      evidence: {
        endpoint: '/orgs/splrad/rulesets',
        relatedEndpoints: ['/orgs/splrad/rulesets/11'],
      },
    });
    expect(organization.requests.map((request) => request.path)).toEqual([
      '/orgs/splrad/rulesets',
      '/orgs/splrad/rulesets/11',
    ]);
  });

  it('reads an exactly 100-entry custom-property schema with one non-paginated request', async () => {
    const schema = Array.from({ length: 100 }, (_, index) => ({
      property_name: `property_${index}`,
      source_type: 'organization',
      value_type: 'string',
      required: false,
      default_value: null,
      allowed_values: null,
      values_editable_by: 'org_actors',
      require_explicit_values: false,
    }));
    const organization = mockTransport((request) => {
      expect(request.path).toBe('/orgs/splrad/properties/schema');
      expect(request.query).toBeUndefined();
      return schema;
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: organization.transport,
      organizationTransport: organization.transport,
      observedAt: () => observedAt,
    });

    const result = await reader.getOrganizationPropertySchema('splrad');

    expect(result).toMatchObject({ status: 'known' });
    if (result.status === 'known') {
      expect(result.value).toHaveLength(100);
      expect(result.value[99]).toMatchObject({ name: 'property_99', valueType: 'string' });
    }
    expect(organization.requests).toHaveLength(1);
  });

  it('accepts the official ID-less DeployKey bypass representation without inventing an actor ID', async () => {
    const organization = mockTransport((request) => {
      if (request.path === '/orgs/splrad/rulesets') return [{
        id: 21,
        name: 'legacy',
        source_type: 'Organization',
        source: 'splrad',
        enforcement: 'active',
      }];
      if (request.path === '/orgs/splrad/rulesets/21') return {
        id: 21,
        name: 'legacy',
        target: 'branch',
        enforcement: 'active',
        source_type: 'Organization',
        source: 'splrad',
        conditions: {
          ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
          repository_name: { include: ['~ALL'], exclude: [] },
        },
        bypass_actors: [{ actor_type: 'DeployKey', bypass_mode: 'exempt' }],
        rules: [{ type: 'deletion' }],
      };
      throw new Error(`Unexpected request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: organization.transport,
      organizationTransport: organization.transport,
      observedAt: () => observedAt,
    });

    const result = await reader.listOrganizationRulesets('splrad');

    expect(result).toMatchObject({
      status: 'known',
      value: [{ bypassActors: [{ actorId: null, actorType: 'DeployKey', bypassMode: 'exempt' }] }],
    });
  });

  it('preserves the failed Actions endpoint and identifies the downstream endpoint it blocked', async () => {
    const settingsPath = '/orgs/splrad/actions/permissions';
    const selectedActionsPath = '/orgs/splrad/actions/permissions/selected-actions';
    const organization = mockTransport((request) => {
      if (request.path === settingsPath) return new GitHubApiError({
        status: 403,
        method: 'GET',
        path: settingsPath,
        message: 'Forbidden',
        requestId: 'GH-REQUEST-123',
      });
      throw new Error(`Unexpected organization request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: organization.transport,
      organizationTransport: organization.transport,
      observedAt: () => observedAt,
    });

    const settings = await reader.getOrganizationActionsSettings('splrad');
    const selectedActions = await reader.getOrganizationSelectedActions('splrad', settings);

    expect(selectedActions).toMatchObject({
      status: 'unknown',
      reason: 'permission-denied',
      httpStatus: 403,
      requestId: 'GH-REQUEST-123',
      evidence: {
        endpoint: settingsPath,
        blockedEndpoint: selectedActionsPath,
      },
    });
    expect(organization.requests.map((request) => request.path)).toEqual([settingsPath]);
  });

  it('paginates maintainer team members used by reviewed governance', async () => {
    const organization = mockTransport((request) => {
      expect(request.path).toBe('/orgs/splrad/teams/maintainers/members');
      expect(request.query).toMatchObject({ role: 'all', per_page: 100 });
      if (request.query?.page === 1) {
        return Array.from({ length: 100 }, (_, index) => ({ login: `maintainer-${index}` }));
      }
      if (request.query?.page === 2) return [{ login: 'maintainer-100' }];
      throw new Error(`Unexpected team-members page: ${String(request.query?.page)}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: organization.transport,
      organizationTransport: organization.transport,
      observedAt: () => observedAt,
    });

    const result = await reader.listTeamMembers('splrad', 'maintainers');

    expect(result).toMatchObject({ status: 'known' });
    if (result.status === 'known') {
      expect(result.value).toHaveLength(101);
      expect(result.value[0]).toBe('maintainer-0');
      expect(result.value[100]).toBe('maintainer-100');
    }
    expect(organization.requests.map((request) => request.query?.page)).toEqual([1, 2]);
  });

  it('distinguishes permission denial, hidden 404, proven absence, and a known empty response', async () => {
    const schemaPath = '/orgs/splrad/properties/schema';
    const valuesPath = '/repos/splrad/example/properties/values';
    const teamAccessPath = '/orgs/splrad/teams/maintainers/repos/splrad/example';
    const organization = mockTransport((request) => {
      if (request.path === schemaPath) return new GitHubApiError({
        status: 403, method: 'GET', path: schemaPath, message: 'Forbidden',
      });
      if (request.path.endsWith('/teams/maintainers')) return { id: 5, slug: 'maintainers' };
      if (request.path === '/repos/splrad/example') return { id: 7, full_name: 'splrad/example' };
      if (request.path === teamAccessPath) return new GitHubApiError({
        status: 404, method: 'GET', path: teamAccessPath, message: 'Not Found',
      });
      if (request.path === '/orgs/splrad/installations') return { installations: [] };
      throw new Error(`Unexpected organization request: ${request.path}`);
    });
    const repository = mockTransport((request) => {
      if (request.path === valuesPath) return new GitHubApiError({
        status: 404, method: 'GET', path: valuesPath, message: 'Not Found',
      });
      throw new Error(`Unexpected repository request: ${request.path}`);
    });
    const appJwt = mockTransport((request) => {
      if (request.path.endsWith('/installation')) return new GitHubApiError({
        status: 403, method: 'GET', path: request.path, message: 'Forbidden',
      });
      throw new Error(`Unexpected App request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: repository.transport,
      organizationTransport: organization.transport,
      appJwtTransport: appJwt.transport,
      observedAt: () => observedAt,
    });

    expect(await reader.getOrganizationPropertySchema('splrad')).toMatchObject({
      status: 'unknown', reason: 'permission-denied', httpStatus: 403,
    });
    expect(await reader.getRepositoryPropertyValues('splrad', 'example')).toMatchObject({
      status: 'unknown', reason: 'not-found-or-hidden', httpStatus: 404,
    });
    expect(await reader.getTeamRepositoryAccess('splrad', 'maintainers', 'splrad', 'example'))
      .toMatchObject({ status: 'not-configured' });
    expect(await reader.getAppInstallation(input)).toMatchObject({ status: 'not-configured' });

    const empty = mockTransport((request) => request.path === schemaPath ? [] : undefined);
    const emptyReader = new GitHubOrganizationReadClient({
      repositoryTransport: empty.transport,
      organizationTransport: empty.transport,
      observedAt: () => observedAt,
    });
    expect(await emptyReader.getOrganizationPropertySchema('splrad')).toMatchObject({
      status: 'known', value: [],
    });
  });

  it('uses user-installation inventory to prove selected repository scope when App JWT proof is unavailable', async () => {
    const repository = mockTransport(() => undefined);
    const organization = mockTransport((request) => {
      if (request.path === '/orgs/splrad/installations') return { installations: [installation('selected')] };
      throw new Error(`Unexpected organization request: ${request.path}`);
    });
    const appJwt = mockTransport((request) => {
      if (request.path === '/repos/splrad/example/installation') return new GitHubApiError({
        status: 403, method: 'GET', path: request.path, message: 'Forbidden',
      });
      throw new Error(`Unexpected App JWT request: ${request.path}`);
    });
    const appUser = mockTransport((request) => {
      if (request.path === '/user/installations/9/repositories') return {
        repositories: [{ id: 7, full_name: 'splrad/example' }],
      };
      throw new Error(`Unexpected App user request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: repository.transport,
      organizationTransport: organization.transport,
      appJwtTransport: appJwt.transport,
      appUserTransport: appUser.transport,
      observedAt: () => observedAt,
    });

    expect(await reader.getAppInstallation(input)).toMatchObject({
      status: 'known',
      value: {
        repositorySelection: 'selected',
        repositoryAccess: { status: 'known', value: true },
        events: ['installation', 'pull_request', 'pull_request_review'],
      },
    });
    expect(appJwt.requests.map((request) => request.path))
      .toEqual(['/repos/splrad/example/installation']);
    expect(appUser.requests.map((request) => request.path))
      .toEqual(['/user/installations/9/repositories']);
  });

  it.each([
    {
      description: 'the repository name matches but its ID does not',
      repository: { id: 8, full_name: 'splrad/example' },
    },
    {
      description: 'the repository ID matches but its full name does not',
      repository: { id: 7, full_name: 'splrad/other' },
    },
  ])('requires both repository identity fields when $description', async ({ repository: selectedRepository }) => {
    const repository = mockTransport(() => undefined);
    const organization = mockTransport((request) => {
      if (request.path === '/orgs/splrad/installations') return { installations: [installation('selected')] };
      throw new Error(`Unexpected organization request: ${request.path}`);
    });
    const appJwt = mockTransport((request) => {
      if (request.path === '/repos/splrad/example/installation') return new GitHubApiError({
        status: 403, method: 'GET', path: request.path, message: 'Forbidden',
      });
      throw new Error(`Unexpected App JWT request: ${request.path}`);
    });
    const appUser = mockTransport((request) => {
      if (request.path === '/user/installations/9/repositories') return {
        repositories: [selectedRepository],
      };
      throw new Error(`Unexpected App user request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: repository.transport,
      organizationTransport: organization.transport,
      appJwtTransport: appJwt.transport,
      appUserTransport: appUser.transport,
      observedAt: () => observedAt,
    });

    expect(await reader.getAppInstallation(input)).toMatchObject({
      status: 'known',
      value: {
        repositorySelection: 'selected',
        repositoryAccess: { status: 'unknown', reason: 'not-found-or-hidden' },
      },
    });
  });

  it('does not treat absence from a selected user repository inventory as authoritative', async () => {
    const repository = mockTransport(() => undefined);
    const organization = mockTransport((request) => {
      if (request.path === '/orgs/splrad/installations') return { installations: [installation('selected')] };
      throw new Error(`Unexpected organization request: ${request.path}`);
    });
    const appJwt = mockTransport((request) => {
      if (request.path === '/repos/splrad/example/installation') return new GitHubApiError({
        status: 403, method: 'GET', path: request.path, message: 'Forbidden',
      });
      throw new Error(`Unexpected App JWT request: ${request.path}`);
    });
    const appUser = mockTransport((request) => {
      if (request.path === '/user/installations/9/repositories') return {
        repositories: [{ id: 8, full_name: 'splrad/other' }],
      };
      throw new Error(`Unexpected App user request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: repository.transport,
      organizationTransport: organization.transport,
      appJwtTransport: appJwt.transport,
      appUserTransport: appUser.transport,
      observedAt: () => observedAt,
    });

    expect(await reader.getAppInstallation(input)).toMatchObject({
      status: 'known',
      value: {
        repositorySelection: 'selected',
        repositoryAccess: { status: 'unknown', reason: 'not-found-or-hidden' },
      },
    });
  });

  it('matches organization installation inventory by frozen App identity instead of Manifest client ID', async () => {
    const repository = mockTransport(() => undefined);
    const organization = mockTransport((request) => {
      if (request.path === '/orgs/splrad/installations') return { installations: [installation()] };
      throw new Error(`Unexpected organization request: ${request.path}`);
    });
    const appJwt = mockTransport((request) => {
      if (request.path === '/repos/splrad/example/installation') return new GitHubApiError({
        status: 403, method: 'GET', path: request.path, message: 'Forbidden',
      });
      throw new Error(`Unexpected App JWT request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: repository.transport,
      organizationTransport: organization.transport,
      appJwtTransport: appJwt.transport,
      observedAt: () => observedAt,
    });
    const mismatchedManifestIdentity = {
      ...input,
      appId: 4243096,
      appClientId: 'manifest-client-id-is-wrong',
    } satisfies GitHubOrganizationContractInput;

    expect(await reader.getAppInstallation(mismatchedManifestIdentity)).toMatchObject({
      status: 'known',
      value: {
        appId: 4243096,
        appSlug: 'splrad-steward',
        accountLogin: 'splrad',
        clientId: 'Iv23liuSr0qd4WLJdZhH',
        repositoryAccess: { status: 'known', value: true },
      },
    });
  });

  it('does not request selected-actions settings when the parent Actions policy is not selected', async () => {
    const settingsPath = '/orgs/splrad/actions/permissions';
    const organization = mockTransport((request) => {
      if (request.path === settingsPath) return {
        enabled_repositories: 'all', allowed_actions: 'all', sha_pinning_required: true,
      };
      throw new Error(`Unexpected organization request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: organization.transport,
      organizationTransport: organization.transport,
      observedAt: () => observedAt,
    });

    const settings = await reader.getOrganizationActionsSettings('splrad');
    const selectedActions = await reader.getOrganizationSelectedActions('splrad', settings);

    expect(selectedActions).toMatchObject({
      status: 'known',
      value: null,
      evidence: { endpoint: settingsPath },
    });
    expect(organization.requests.map((request) => request.path)).toEqual([settingsPath]);
  });

  it('does not turn a hidden repository or incomplete user installation inventory into proven absence', async () => {
    const teamPath = '/orgs/splrad/teams/maintainers';
    const repositoryPath = '/repos/splrad/example';
    const organization = mockTransport((request) => {
      if (request.path === teamPath) return { id: 5, slug: 'maintainers' };
      if (request.path === repositoryPath) return new GitHubApiError({
        status: 404, method: 'GET', path: repositoryPath, message: 'Not Found',
      });
      if (request.path === '/orgs/splrad/installations') return new GitHubApiError({
        status: 403, method: 'GET', path: request.path, message: 'Forbidden',
      });
      throw new Error(`Unexpected organization request: ${request.path}`);
    });
    const repository = mockTransport((request) => {
      throw new Error(`Unexpected repository request: ${request.path}`);
    });
    const appJwt = mockTransport((request) => {
      if (request.path === '/repos/splrad/example/installation') return new GitHubApiError({
        status: 404, method: 'GET', path: request.path, message: 'Not Found',
      });
      throw new Error(`Unexpected App JWT request: ${request.path}`);
    });
    const appUser = mockTransport((request) => {
      if (request.path === '/user/installations') return { installations: [] };
      throw new Error(`Unexpected App user request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: repository.transport,
      organizationTransport: organization.transport,
      appJwtTransport: appJwt.transport,
      appUserTransport: appUser.transport,
      observedAt: () => observedAt,
    });

    expect(await reader.getTeamRepositoryAccess('splrad', 'maintainers', 'splrad', 'example'))
      .toMatchObject({ status: 'unknown', reason: 'not-found-or-hidden' });
    expect(await reader.getAppInstallation(input))
      .toMatchObject({ status: 'unknown', reason: 'not-found-or-hidden' });
    expect(appJwt.requests.map((request) => request.path))
      .toEqual(['/repos/splrad/example/installation']);
    expect(appUser.requests.map((request) => request.path))
      .toEqual(['/user/installations']);
  });

  it('fails closed on malformed successful payloads and preserves duplicate facts for policy evaluation', async () => {
    const duplicate = propertySchema();
    duplicate.push(structuredClone(duplicate[0]));
    const organization = mockTransport((request) => {
      if (request.path.endsWith('/properties/schema')) return duplicate;
      throw new Error(`Unexpected request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: organization.transport,
      organizationTransport: organization.transport,
      observedAt: () => observedAt,
    });
    const result = await reader.getOrganizationPropertySchema('splrad');
    expect(result).toMatchObject({ status: 'known' });
    if (result.status === 'known') expect(result.value).toHaveLength(5);

    const malformed = mockTransport(() => [{ property_name: 'steward_state', value: 42 }]);
    const malformedReader = new GitHubOrganizationReadClient({ repositoryTransport: malformed.transport });
    await expect(malformedReader.getRepositoryPropertyValues('splrad', 'example'))
      .resolves.toMatchObject({ status: 'unknown', reason: 'invalid-response', retryable: false });
  });

  it('does not normalize a missing required installation suspended_at field to null', async () => {
    const malformedInstallation = installation();
    delete malformedInstallation.suspended_at;
    const appJwt = mockTransport((request) => {
      if (request.path === '/repos/splrad/example/installation') return malformedInstallation;
      throw new Error(`Unexpected request: ${request.path}`);
    });
    const organization = mockTransport((request) => {
      if (request.path === '/orgs/splrad/installations') return { installations: [] };
      throw new Error(`Unexpected request: ${request.path}`);
    });
    const reader = new GitHubOrganizationReadClient({
      repositoryTransport: organization.transport,
      organizationTransport: organization.transport,
      appJwtTransport: appJwt.transport,
      observedAt: () => observedAt,
    });

    await expect(reader.getAppInstallation(input))
      .resolves.toMatchObject({ status: 'unknown', reason: 'invalid-response', retryable: false });
    expect(organization.requests).toEqual([]);
  });
});
