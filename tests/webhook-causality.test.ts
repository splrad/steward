import { describe, expect, it } from 'vitest';
import {
  classifyWebhookCausality,
  type StewardWebhookCausalityContract,
  type TrustedWebhookCausalityInput,
  type WebhookCausalityDecision,
} from '../packages/core/src/webhook-causality.js';

const installationId = 145_952_003;
const maintainerTeamId = 80_001;
const organizationId = 70_001;
const repositoryId = 1_296_724_484;

const contract: StewardWebhookCausalityContract = {
  propertyNames: ['steward_state', 'steward_ring', 'governance_tier', 'ci_profile'],
  maintainerTeamId,
  maintainerTeamSlug: 'maintainers',
};

function delivery(
  event: string,
  action: string | null,
  payload: Record<string, unknown>,
): TrustedWebhookCausalityInput {
  return {
    event,
    action,
    payload: action === null ? payload : { action, ...payload },
  };
}

function installation(accountId = organizationId) {
  return { id: installationId, account: { id: accountId, login: 'untrusted-account-name' } };
}

function repository(id = repositoryId, fullName = 'untrusted-owner/untrusted-name') {
  return { id, full_name: fullName, name: fullName.split('/').at(-1) };
}

function team(id = maintainerTeamId, slug = 'untrusted-team-slug') {
  return { id, slug, name: slug };
}

function classify(input: TrustedWebhookCausalityInput): WebhookCausalityDecision {
  return classifyWebhookCausality(input, contract);
}

function expectInstallationRefresh(
  decision: WebhookCausalityDecision,
  cause: string,
): void {
  expect(decision).toMatchObject({
    disposition: 'reconcile',
    cause,
    target: {
      scope: 'installation',
      mode: 'refresh',
      installationId,
      repositories: 'all-live',
      pullRequests: 'all-open',
    },
  });
  if (decision.disposition === 'reconcile') {
    expect(decision.liveReads[0]).toBe('installation');
    expect(decision.liveReads).toContain('open-pull-requests');
    expect(decision.liveReads).toContain('pull-request-governance-inputs');
  }
}

function expectRepositoryRefresh(
  decision: WebhookCausalityDecision,
  cause: string,
  expectedRepositoryId = repositoryId,
): void {
  expect(decision).toMatchObject({
    disposition: 'reconcile',
    cause,
    target: {
      scope: 'repository',
      mode: 'refresh',
      installationId,
      repositoryId: expectedRepositoryId,
      pullRequests: 'all-open',
    },
  });
  if (decision.disposition === 'reconcile') {
    expect(decision.liveReads[0]).toBe('installation');
    expect(decision.liveReads).toContain('repository');
    expect(decision.liveReads).toContain('open-pull-requests');
  }
}

describe('Webhook causality for organization custom properties', () => {
  it.each(['created', 'updated', 'deleted', 'promote_to_enterprise'])(
    'fans out a governed schema %s event to every live installation repository and PR',
    (action) => {
      const decision = classify(delivery('custom_property', action, {
        installation: installation(),
        definition: { property_name: 'steward_state' },
      }));

      expectInstallationRefresh(decision, 'organization-property-schema-changed');
      if (decision.disposition === 'reconcile') {
        expect(decision.liveReads).toContain('organization-property-schema');
        expect(decision.liveReads).toContain('repository-property-values');
      }
    },
  );

  it('reconciles an update whose current name is unrelated because no prior-name contract exists', () => {
    const decision = classify(delivery('custom_property', 'updated', {
      installation: installation(),
      definition: { property_name: 'new_unmanaged_name' },
    }));

    expectInstallationRefresh(decision, 'organization-property-schema-changed');
  });

  it('ignores an unrelated schema for non-update actions', () => {
    expect(classify(delivery('custom_property', 'created', {
      installation: installation(),
      definition: { property_name: 'cost_center' },
    }))).toEqual({ disposition: 'ignore', reason: 'unrelated-property' });
  });

  it.each([
    ['an unrelated field delta', { description: { from: 'old' } }],
    ['a rename-shaped hint', { property_name: { from: 'governance_tier' } }],
    ['an incomplete rename-shaped hint', { property_name: {} }],
    ['null', null],
    ['an array', []],
  ])('ignores undocumented changes extensions (%s) and rereads the live schema', (_label, changes) => {
    const decision = classify(delivery('custom_property', 'updated', {
      installation: installation(),
      definition: { property_name: 'cost_center' },
      changes,
    }));

    expectInstallationRefresh(decision, 'organization-property-schema-changed');
  });

  it('routes a governed repository property delta by repository ID, not full_name', () => {
    const first = classify(delivery('custom_property_values', 'updated', {
      installation: installation(),
      repository: repository(repositoryId, 'old-owner/old-name'),
      old_property_values: [{ property_name: 'steward_state', value: 'bootstrapping' }],
      new_property_values: [{ property_name: 'steward_state', value: 'active' }],
    }));
    const renamed = classify(delivery('custom_property_values', 'updated', {
      installation: installation(),
      repository: repository(repositoryId, 'new-owner/new-name'),
      old_property_values: [{ property_name: 'steward_state', value: 'bootstrapping' }],
      new_property_values: [{ property_name: 'steward_state', value: 'active' }],
    }));

    expectRepositoryRefresh(first, 'repository-property-values-changed');
    expect(renamed).toEqual(first);
  });

  it('treats property-value payload details only as a trigger and always re-reads live values', () => {
    expectRepositoryRefresh(classify(delivery('custom_property_values', 'updated', {
      installation: installation(),
      repository: repository(),
      old_property_values: [{ property_name: 'ci_profile', value: 'codeql' }],
      new_property_values: [{ property_name: 'cost_center', value: 'x' }],
    })), 'repository-property-values-changed');

    expectRepositoryRefresh(classify(delivery('custom_property_values', 'updated', {
      installation: installation(),
      repository: repository(),
      old_property_values: [{ property_name: 'cost_center', value: 'x' }],
      new_property_values: [{ property_name: 'region', value: 'apac' }],
    })), 'repository-property-values-changed');

    expectRepositoryRefresh(classify(delivery('custom_property_values', 'updated', {
      installation: installation(),
      repository: repository(),
    })), 'repository-property-values-changed');
  });
});

describe('Webhook causality for the maintainer team', () => {
  it.each(['added', 'removed'])(
    'fans out exact maintainer team membership %s by numeric team ID',
    (action) => {
      const decision = classify(delivery('membership', action, {
        installation: installation(),
        scope: 'team',
        team: team(),
        member: { id: 91_001, login: 'untrusted-member-login' },
      }));

      expectInstallationRefresh(decision, 'maintainer-team-membership-changed');
      if (decision.disposition === 'reconcile') {
        expect(decision.liveReads).toContain('maintainer-team-members');
        expect(decision.liveReads).toContain('maintainer-team-repository-access');
      }
    },
  );

  it('ignores a same-slug foreign team and quarantines malformed exact-team membership', () => {
    expect(classify(delivery('membership', 'added', {
      installation: installation(),
      scope: 'team',
      team: team(maintainerTeamId + 1, 'maintainers'),
      member: { id: 91_001 },
    }))).toEqual({ disposition: 'ignore', reason: 'unrelated-team' });

    expect(classify(delivery('membership', 'added', {
      installation: installation(),
      scope: 'organization',
      team: team(),
      member: { id: 91_001 },
    }))).toEqual({ disposition: 'quarantine', reason: 'malformed-payload', field: 'scope' });
  });

  it.each(['created', 'edited', 'deleted'])(
    'fans out maintainer team definition action %s installation-wide',
    (action) => {
      expectInstallationRefresh(classify(delivery('team', action, {
        installation: installation(),
        team: team(),
      })), 'maintainer-team-definition-changed');
    },
  );

  it('detects a recreated maintainers Team by canonical slug only on creation', () => {
    expectInstallationRefresh(classify(delivery('team', 'created', {
      installation: installation(),
      team: team(maintainerTeamId + 1, 'maintainers'),
    })), 'maintainer-team-definition-changed');
    expect(classify(delivery('team', 'edited', {
      installation: installation(),
      team: team(maintainerTeamId + 1, 'maintainers'),
      changes: { name: { from: 'old' } },
    }))).toEqual({ disposition: 'ignore', reason: 'unrelated-team' });
  });

  it('keeps a Team repository-permission edit repository-scoped', () => {
    expectRepositoryRefresh(classify(delivery('team', 'edited', {
      installation: installation(),
      team: team(),
      repository: repository(),
      changes: { repository: { permissions: { from: { push: true } } } },
    })), 'maintainer-team-repository-access-changed');
  });

  it.each(['added_to_repository', 'removed_from_repository'])(
    'keeps team repository access action %s repository-scoped',
    (action) => {
      const decision = classify(delivery('team', action, {
        installation: installation(),
        team: team(),
        repository: repository(),
      }));

      expectRepositoryRefresh(decision, 'maintainer-team-repository-access-changed');
      if (decision.disposition === 'reconcile') {
        expect(decision.liveReads).toContain('maintainer-team-repository-access');
      }
    },
  );

  it('canonicalizes the actionless team_add alias to the same repository access decision', () => {
    const payload = {
      installation: installation(),
      team: team(),
      repository: repository(),
    };
    const canonical = classify(delivery('team', 'added_to_repository', payload));
    const alias = classify(delivery('team_add', null, payload));

    expect(alias).toEqual(canonical);
  });

  it('quarantines a relevant team repository event without a stable repository ID', () => {
    expect(classify(delivery('team', 'added_to_repository', {
      installation: installation(),
      team: team(),
      repository: { full_name: 'splrad/steward' },
    }))).toEqual({
      disposition: 'quarantine',
      reason: 'malformed-payload',
      field: 'repository.id',
    });
  });
});

describe('Webhook causality for repository and installation lifecycle', () => {
  it.each([
    'archived',
    'created',
    'edited',
    'privatized',
    'publicized',
    'renamed',
    'transferred',
    'unarchived',
  ])('refreshes repository lifecycle action %s by immutable repository ID', (action) => {
    expectRepositoryRefresh(classify(delivery('repository', action, {
      installation: installation(),
      repository: repository(),
      changes: { repository: { name: { from: 'old-untrusted-name' } } },
    })), 'repository-lifecycle-changed');
  });

  it('re-reads a deleted repository by ID before deciding whether it is absent', () => {
    const decision = classify(delivery('repository', 'deleted', {
      installation: installation(),
      repository: repository(repositoryId, 'already-gone/name'),
    }));

    expectRepositoryRefresh(decision, 'repository-deleted');
  });

  it.each(['created', 'new_permissions_accepted', 'unsuspend'])(
    'refreshes all live repositories for installation action %s',
    (action) => {
      expectInstallationRefresh(classify(delivery('installation', action, {
        installation: installation(),
        repositories: [repository()],
      })), 'installation-lifecycle-changed');
    },
  );

  it.each([
    ['suspend', 'installation-suspended'],
    ['deleted', 'installation-deleted'],
  ] as const)('re-reads live installation state for destructive action %s', (action, cause) => {
    expectInstallationRefresh(classify(delivery('installation', action, {
      installation: installation(),
    })), cause);
  });

  it('sorts and deduplicates every repository in an installation add delta', () => {
    const decision = classify(delivery('installation_repositories', 'added', {
      installation: installation(),
      repositories_added: [
        repository(40, 'wrong/fourth'),
        repository(20, 'wrong/second'),
        repository(40, 'other/duplicate-name'),
        repository(30, 'wrong/third'),
      ],
      repositories_removed: [],
    }));

    expect(decision).toMatchObject({
      disposition: 'reconcile',
      cause: 'installation-repositories-added',
      target: {
        scope: 'repository-set',
        mode: 'refresh',
        installationId,
        repositoryIds: [20, 30, 40],
        pullRequests: 'all-open',
      },
    });
    if (decision.disposition === 'reconcile') expect(decision.liveReads[0]).toBe('installation');
  });

  it('re-reads current installation scope before removing repository IDs and rejects contradictory deltas', () => {
    expect(classify(delivery('installation_repositories', 'removed', {
      installation: installation(),
      repositories_added: [],
      repositories_removed: [repository(9), repository(7), repository(9)],
    }))).toEqual({
      disposition: 'reconcile',
      cause: 'installation-repositories-removed',
      target: {
        scope: 'repository-set',
        mode: 'refresh',
        installationId,
        repositoryIds: [7, 9],
        pullRequests: 'all-open',
      },
      liveReads: expect.arrayContaining(['installation', 'installation-repositories']),
    });

    expect(classify(delivery('installation_repositories', 'added', {
      installation: installation(),
      repositories_added: [repository(7)],
      repositories_removed: [repository(9)],
    }))).toEqual({
      disposition: 'quarantine',
      reason: 'malformed-payload',
      field: 'installation_repositories.delta',
    });
  });

  it('reconciles an organization installation target rename using account and installation IDs', () => {
    const decision = classify(delivery('installation_target', 'renamed', {
      installation: installation(),
      target_type: 'Organization',
      account: { id: organizationId, login: 'new-untrusted-login' },
      changes: { login: { from: 'old-untrusted-login' } },
    }));

    expectInstallationRefresh(decision, 'installation-target-renamed');
    expect(decision).toMatchObject({ target: { accountId: organizationId } });

    expect(classify(delivery('installation_target', 'renamed', {
      installation: installation(),
      target_type: 'Organization',
      account: { id: organizationId + 1, login: 'same-login-is-not-authority' },
      changes: {},
    }))).toEqual({
      disposition: 'quarantine',
      reason: 'malformed-payload',
      field: 'installation.account.id',
    });
  });
});

describe('Webhook causality fail-closed and delivery-order invariants', () => {
  it.each([
    delivery('custom_property', 'future_action', {
      installation: installation(), definition: { property_name: 'steward_state' },
    }),
    delivery('membership', 'future_action', {
      installation: installation(), team: team(), scope: 'team', member: null,
    }),
    delivery('repository', 'future_action', {
      installation: installation(), repository: repository(),
    }),
    delivery('installation', 'future_action', { installation: installation() }),
  ])('quarantines unsupported actions for relevant event $event', (input) => {
    expect(classify(input)).toEqual({
      disposition: 'quarantine',
      reason: 'unsupported-action',
      field: 'action',
    });
  });

  it('quarantines an action header/body mismatch and ignores a wholly unsupported event', () => {
    expect(classify({
      event: 'repository',
      action: 'renamed',
      payload: {
        action: 'deleted',
        installation: installation(),
        repository: repository(),
      },
    })).toEqual({
      disposition: 'quarantine',
      reason: 'action-mismatch',
      field: 'payload.action',
    });

    expect(classify({ event: 'ping', action: null, payload: null }))
      .toEqual({ disposition: 'ignore', reason: 'unsupported-event' });
  });

  it('is deterministic for duplicate delivery payloads', () => {
    const duplicate = delivery('membership', 'removed', {
      installation: installation(),
      scope: 'team',
      team: team(),
      member: null,
    });

    expect(classify(structuredClone(duplicate))).toEqual(classify(structuredClone(duplicate)));
  });

  it('keeps stale out-of-order events safe by requiring installation-first live reads', () => {
    const deleted = classify(delivery('repository', 'deleted', {
      installation: installation(),
      repository: repository(),
    }));
    const staleRename = classify(delivery('repository', 'renamed', {
      installation: installation(),
      repository: repository(repositoryId, 'stale/name'),
      changes: { repository: { name: { from: 'older-name' } } },
    }));
    const suspended = classify(delivery('installation', 'suspend', {
      installation: installation(),
    }));
    const staleRepositoryAdd = classify(delivery('installation_repositories', 'added', {
      installation: installation(),
      repositories_added: [repository()],
      repositories_removed: [],
    }));

    expect(deleted).toMatchObject({ target: { mode: 'refresh', repositoryId } });
    expect(staleRename).toMatchObject({ target: { mode: 'refresh', repositoryId } });
    expect(suspended).toMatchObject({ target: { mode: 'refresh', installationId } });
    expect(staleRepositoryAdd).toMatchObject({ target: { mode: 'refresh', repositoryIds: [repositoryId] } });
    if (deleted.disposition === 'reconcile') expect(deleted.liveReads[0]).toBe('installation');
    if (staleRename.disposition === 'reconcile') expect(staleRename.liveReads[0]).toBe('installation');
    if (suspended.disposition === 'reconcile') expect(suspended.liveReads[0]).toBe('installation');
    if (staleRepositoryAdd.disposition === 'reconcile') {
      expect(staleRepositoryAdd.liveReads[0]).toBe('installation');
    }
  });

  it.each([
    ['unsuspend', 'suspend'],
    ['created', 'deleted'],
  ] as const)(
    'cannot regress a live installation when newer %s is followed by stale %s',
    (newerAction, staleAction) => {
      const sequence = [newerAction, staleAction].map((action) => classify(delivery(
        'installation',
        action,
        { installation: installation() },
      )));

      for (const decision of sequence) {
        expect(decision).toMatchObject({
          disposition: 'reconcile',
          target: { scope: 'installation', mode: 'refresh', installationId },
        });
        if (decision.disposition === 'reconcile') {
          expect(decision.liveReads[0]).toBe('installation');
          expect(decision.target.mode).toBe('refresh');
        }
      }
    },
  );

  it('cannot tombstone a recreated repository when its stale delete arrives last', () => {
    const sequence = ['created', 'deleted'].map((action) => classify(delivery(
      'repository',
      action,
      { installation: installation(), repository: repository() },
    )));

    for (const decision of sequence) {
      expect(decision).toMatchObject({
        disposition: 'reconcile',
        target: { scope: 'repository', mode: 'refresh', installationId, repositoryId },
      });
      if (decision.disposition === 'reconcile') {
        expect(decision.liveReads.slice(0, 2)).toEqual(['installation', 'repository']);
        expect(decision.target.mode).toBe('refresh');
      }
    }
  });

  it('rejects malformed stable IDs rather than falling back to names or slugs', () => {
    expect(classify(delivery('team_add', null, {
      installation: installation(),
      team: { id: String(maintainerTeamId), slug: 'maintainers' },
      repository: repository(),
    }))).toEqual({ disposition: 'quarantine', reason: 'malformed-payload', field: 'team.id' });

    expect(classify(delivery('repository', 'renamed', {
      installation: installation(),
      repository: { id: String(repositoryId), full_name: 'splrad/steward' },
    }))).toEqual({ disposition: 'quarantine', reason: 'malformed-payload', field: 'repository.id' });
  });

  it('rejects invalid static causality contracts before inspecting an event', () => {
    expect(() => classifyWebhookCausality(
      { event: 'ping', action: null, payload: {} },
      { propertyNames: ['steward_state', 'steward_state'], maintainerTeamId, maintainerTeamSlug: 'maintainers' },
    )).toThrow('propertyNames must contain unique non-empty strings');

    expect(() => classifyWebhookCausality(
      { event: 'ping', action: null, payload: {} },
      { propertyNames: ['steward_state'], maintainerTeamId: 0, maintainerTeamSlug: 'maintainers' },
    )).toThrow('maintainerTeamId must be a positive safe integer');
  });
});
