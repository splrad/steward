import { describe, expect, it } from 'vitest';
import {
  bindStewardOrganizationRulesetContract,
  compareStewardOrganizationRules,
  hashJson,
  STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT,
  STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT_DIGEST,
  STEWARD_ACTIONS_EXECUTION_POLICIES,
  STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST,
  STEWARD_ACTIONS_SOURCE_INVENTORY,
  STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST,
  STEWARD_APP_IMPLICIT_EVENTS,
  STEWARD_APP_REQUIRED_PERMISSIONS,
  STEWARD_APP_REQUIRED_EXPLICIT_EVENTS,
  STEWARD_ORGANIZATION_PROPERTIES,
  STEWARD_ORGANIZATION_RULESET_CONTRACTS,
  STEWARD_ORGANIZATION_RULESETS,
} from '../packages/core/src/index.js';

describe('organization-native policy contracts', () => {
  it('keeps governance selectors owner-controlled and excludes repository-level property writes', () => {
    expect(STEWARD_ORGANIZATION_PROPERTIES.every(
      (property) => property.valuesEditableBy === 'org_actors',
    )).toBe(true);
    expect(STEWARD_APP_REQUIRED_PERMISSIONS.organization_custom_properties).toBe('read');
    expect(STEWARD_APP_REQUIRED_PERMISSIONS).not.toHaveProperty('repository_custom_properties');
  });

  it('accepts every frozen Ruleset fixture and only documented server-normalized defaults', () => {
    for (const contract of STEWARD_ORGANIZATION_RULESET_CONTRACTS) {
      const bound = contract.requiredReviewerTeam
        ? bindStewardOrganizationRulesetContract(contract, 5)
        : contract;
      expect(compareStewardOrganizationRules(bound, bound.rules)).toEqual({ state: 'conformant' });
    }

    const base = STEWARD_ORGANIZATION_RULESET_CONTRACTS.find(
      (contract) => contract.name === STEWARD_ORGANIZATION_RULESETS.baseSafety,
    )!;
    const normalized = base.rules.map((rule) => rule.type === 'pull_request'
      ? {
        ...rule,
        parameters: {
          ...rule.parameters,
          required_reviewers: undefined,
          dismissal_restriction: { enabled: false, allowed_actors: [] },
        },
      }
      : rule);
    expect(compareStewardOrganizationRules(base, normalized)).toEqual({ state: 'conformant' });
  });

  it('reports well-typed policy differences as drift and unsupported response fields as unknown', () => {
    const human = bindStewardOrganizationRulesetContract(
      STEWARD_ORGANIZATION_RULESET_CONTRACTS.find(
        (contract) => contract.name === STEWARD_ORGANIZATION_RULESETS.humanReview,
      )!,
      5,
    );
    const changed = human.rules.map((rule) => ({
      ...rule,
      parameters: { ...rule.parameters, required_approving_review_count: 2 },
    }));
    expect(compareStewardOrganizationRules(human, changed)).toMatchObject({ state: 'drift' });

    const unsupported = human.rules.map((rule) => ({
      ...rule,
      parameters: { ...rule.parameters, future_server_field: true },
    }));
    expect(compareStewardOrganizationRules(human, unsupported)).toMatchObject({ state: 'unknown' });
    expect(compareStewardOrganizationRules(human, [...human.rules, human.rules[0]!]))
      .toMatchObject({ state: 'drift' });
  });

  it('binds Human Review to the live maintainer Team identity and all changed files', () => {
    const template = STEWARD_ORGANIZATION_RULESET_CONTRACTS.find(
      (contract) => contract.name === STEWARD_ORGANIZATION_RULESETS.humanReview,
    )!;
    expect(() => compareStewardOrganizationRules(template, template.rules))
      .toThrow('must be bound to its live reviewer Team ID');

    const bound = bindStewardOrganizationRulesetContract(template, 5);
    const wrongTeam = bound.rules.map((rule) => ({
      ...rule,
      parameters: {
        ...rule.parameters,
        required_reviewers: [{
          file_patterns: ['**'],
          minimum_approvals: 1,
          reviewer: { id: 6, type: 'Team' },
        }],
      },
    }));
    expect(compareStewardOrganizationRules(bound, wrongTeam)).toMatchObject({ state: 'drift' });

    const malformed = bound.rules.map((rule) => ({
      ...rule,
      parameters: {
        ...rule.parameters,
        required_reviewers: [{
          file_patterns: [],
          minimum_approvals: 1,
          reviewer: { id: 5, type: 'Team' },
        }],
      },
    }));
    expect(compareStewardOrganizationRules(bound, malformed)).toMatchObject({ state: 'unknown' });
  });

  it('keeps the public-preview owner-attestation contract digest reproducible', async () => {
    expect(await hashJson(STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT))
      .toBe(STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT_DIGEST);
    expect(STEWARD_ACTIONS_EXECUTION_PROTECTION_CONTRACT).toMatchObject({
      schemaVersion: 2,
      policyInventoryStatus: 'frozen',
      expectedPolicyCount: STEWARD_ACTIONS_EXECUTION_POLICIES.length,
      inventoryVersion: STEWARD_ACTIONS_SOURCE_INVENTORY.inventoryVersion,
      inventoryDigest: STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST,
      policyDigest: STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST,
    });
  });

  it('does not require global App lifecycle events in the installation subscription array', () => {
    expect(STEWARD_APP_IMPLICIT_EVENTS).toContain('installation_target');
    expect(STEWARD_APP_REQUIRED_EXPLICIT_EVENTS).not.toContain('installation_target');
  });
});
