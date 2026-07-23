import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  hashJson,
  STEWARD_ACTIONS_EXECUTION_POLICIES,
  STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST,
  STEWARD_ACTIONS_GENERAL_POLICY,
  STEWARD_ACTIONS_SOURCE_INVENTORY,
  STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST,
  STEWARD_APP_ID,
  STEWARD_APP_SLUG,
  type StewardActionsTrigger,
  type StewardActionsWorkflowInventoryEntry,
} from '../packages/core/src/index.js';

const repositoryRoot = new URL('../', import.meta.url);

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function names(source: string, scope: 'secrets' | 'vars'): string[] {
  const pattern = new RegExp(`\\$\\{\\{\\s*${scope}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  return sortedUnique([...source.matchAll(pattern)].map((match) => match[1] ?? ''));
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return sortedUnique(value.map(String));
}

function normalizeTriggers(value: unknown): StewardActionsTrigger[] {
  if (typeof value === 'string') return [{ event: value }];
  if (Array.isArray(value)) return value.map((event) => ({ event: String(event) }))
    .sort((left, right) => left.event.localeCompare(right.event));
  if (!value || typeof value !== 'object') throw new TypeError('workflow on must be an event mapping');
  return Object.entries(value as Record<string, unknown>).map(([event, raw]) => {
    const configuration = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const actions = strings(configuration.types);
    const branches = strings(configuration.branches);
    const branchesIgnore = strings(configuration['branches-ignore']);
    const paths = strings(configuration.paths);
    const workflowNames = strings(configuration.workflows);
    const inputs = configuration.inputs && typeof configuration.inputs === 'object'
      ? Object.keys(configuration.inputs).sort()
      : undefined;
    return {
      event,
      ...(actions?.length ? { actions } : {}),
      ...(branches?.length ? { branches } : {}),
      ...(branchesIgnore?.length ? { branchesIgnore } : {}),
      ...(paths?.length ? { paths } : {}),
      ...(workflowNames?.length ? { workflowNames } : {}),
      ...(inputs?.length ? { inputs } : {}),
    };
  }).sort((left, right) => left.event.localeCompare(right.event));
}

function collectUses(value: unknown, result: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const child of value) collectUses(child, result);
  } else if (value && typeof value === 'object') {
    for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
      if (name === 'uses' && typeof child === 'string') result.push(child);
      else collectUses(child, result);
    }
  }
  return result;
}

function actorContract(
  path: string,
  source: string,
): Pick<StewardActionsWorkflowInventoryEntry, 'actorModel' | 'actorGuards'> {
  if (path.startsWith('.github/workflows/') && /^on:\r?\n  workflow_call:/m.test(source)) {
    return { actorModel: 'inherited-caller-context', actorGuards: [] };
  }
  const botGuard = "!endsWith(github.actor, '[bot]')";
  return source.includes(botGuard)
    ? { actorModel: 'github-actor-with-bot-suffix-denied', actorGuards: [botGuard] }
    : { actorModel: 'event-originating-actor', actorGuards: [] };
}

function executesRepositoryCode(path: string): boolean {
  return path === '.github/workflows/ci.yml'
    || path === '.github/workflows/deploy-relay.yml'
    || path === '.github/workflows/release.yml';
}

async function sourceProjection(
  entry: StewardActionsWorkflowInventoryEntry,
): Promise<Omit<StewardActionsWorkflowInventoryEntry, 'mutationPrincipals'>> {
  const source = await readFile(new URL(entry.path, repositoryRoot), 'utf8');
  const workflow = parse(source) as Record<string, unknown>;
  const surface = entry.path.startsWith('templates/')
    ? 'legacy-consumer-template'
    : /^on:\r?\n  workflow_call:/m.test(source)
      ? 'platform-reusable'
      : 'platform-direct';
  return {
    path: entry.path,
    surface,
    ...(surface === 'legacy-consumer-template'
      ? { generatedPath: entry.path.replace('templates/thin-workflows/', '.github/workflows/') }
      : {}),
    ...actorContract(entry.path, source),
    triggers: normalizeTriggers(workflow.on),
    uses: sortedUnique(collectUses(workflow)),
    credentialVariables: names(source, 'vars'),
    credentialSecrets: names(source, 'secrets'),
    executesRepositoryCode: executesRepositoryCode(entry.path),
  };
}

describe('Steward Actions source inventory', () => {
  it('covers every source workflow exactly and freezes triggers, actors, uses, and credentials', async () => {
    const actualPaths = (await Promise.all(
      STEWARD_ACTIONS_SOURCE_INVENTORY.workflowRoots.map(async (root) => (
        (await readdir(new URL(`${root}/`, repositoryRoot)))
          .filter((name) => /\.ya?ml$/i.test(name))
          .map((name) => `${root}/${name}`)
      )),
    )).flat().sort();
    const expectedPaths = STEWARD_ACTIONS_SOURCE_INVENTORY.workflows.map(({ path }) => path).sort();
    expect(actualPaths).toEqual(expectedPaths);

    for (const expected of STEWARD_ACTIONS_SOURCE_INVENTORY.workflows) {
      const {
        mutationPrincipals: _principals,
        ...expectedSourceProjection
      } = expected;
      expect(await sourceProjection(expected), expected.path).toEqual(expectedSourceProjection);
      expect(expected.mutationPrincipals.length, expected.path).toBeGreaterThan(0);
      expect(sortedUnique(expected.mutationPrincipals), expected.path).toEqual(expected.mutationPrincipals);
    }
  });

  it('keeps bundled thin templates byte-identical to their inventoried sources', async () => {
    for (const entry of STEWARD_ACTIONS_SOURCE_INVENTORY.workflows) {
      if (entry.surface !== 'legacy-consumer-template') continue;
      const name = entry.path.split('/').at(-1);
      expect(name).toBeTruthy();
      const [source, bundled] = await Promise.all([
        readFile(new URL(entry.path, repositoryRoot)),
        readFile(new URL(`packages/cli/dist/templates/thin-workflows/${name}`, repositoryRoot)),
      ]);
      expect(bundled, entry.path).toEqual(source);
    }
  });

  it('binds every summarized workflow and supporting Actions source byte-for-byte', async () => {
    const expectedPaths = [
      '.github/dependabot.yml',
      'action/action.yml',
      ...STEWARD_ACTIONS_SOURCE_INVENTORY.workflows.map(({ path }) => path),
    ].sort();
    expect(Object.keys(STEWARD_ACTIONS_SOURCE_INVENTORY.sourceDigests).sort())
      .toEqual(expectedPaths);
    for (const [path, digest] of Object.entries(
      STEWARD_ACTIONS_SOURCE_INVENTORY.sourceDigests,
    )) {
      const source = await readFile(new URL(path, repositoryRoot));
      expect(createHash('sha256').update(source).digest('hex'), path).toBe(digest);
    }
  });

  it('freezes the JavaScript Action entrypoint and Dependabot ecosystems', async () => {
    const action = parse(await readFile(new URL('action/action.yml', repositoryRoot), 'utf8')) as {
      runs?: { using?: unknown; main?: unknown };
    };
    expect({
      path: 'action/action.yml',
      using: action.runs?.using,
      main: action.runs?.main,
    }).toEqual(STEWARD_ACTIONS_SOURCE_INVENTORY.actionEntrypoint);

    const dependabot = parse(await readFile(new URL('.github/dependabot.yml', repositoryRoot), 'utf8')) as {
      updates?: Array<{ 'package-ecosystem'?: unknown }>;
    };
    expect(sortedUnique((dependabot.updates ?? []).map((update) => String(update['package-ecosystem']))))
      .toEqual(STEWARD_ACTIONS_SOURCE_INVENTORY.dependencyUpdateEcosystems);
  });

  it('derives one exact preview policy and a compatible stable Actions allowlist', () => {
    expect(STEWARD_ACTIONS_EXECUTION_POLICIES).toHaveLength(1);
    const policy = STEWARD_ACTIONS_EXECUTION_POLICIES[0]!;
    expect(policy.allowedActors).toEqual(STEWARD_ACTIONS_SOURCE_INVENTORY.executionPolicyActors);
    expect(policy.allowedActors.integrations[0])
      .toEqual({ kind: 'github-app', id: STEWARD_APP_ID, slug: STEWARD_APP_SLUG });
    expect(policy.allowedEvents).toEqual(sortedUnique(
      STEWARD_ACTIONS_SOURCE_INVENTORY.workflows.flatMap(
        ({ triggers }) => triggers.map(({ event }) => event),
      ),
    ));
    expect(STEWARD_ACTIONS_GENERAL_POLICY).toMatchObject({
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
    });

    for (const workflow of STEWARD_ACTIONS_SOURCE_INVENTORY.workflows) {
      for (const reference of workflow.uses) {
        expect(reference, workflow.path).toMatch(
          /^(?:actions\/[^@]+@[0-9a-f]{40}|splrad\/[^@]+@(?:[0-9a-f]{40}|__STEWARD_SHA__))$/,
        );
        if (!reference.startsWith('splrad/')) continue;
        expect(
          reference.startsWith('splrad/steward/action@')
          || reference.startsWith('splrad/steward/.github/workflows/'),
          `${workflow.path}: ${reference}`,
        ).toBe(true);
      }
    }
    expect(STEWARD_ACTIONS_GENERAL_POLICY.selectedActions.patternsAllowed)
      .toEqual([
        'splrad/steward/.github/workflows/*@*',
        'splrad/steward/action@*',
      ]);
  });

  it('keeps inventory and preview-policy digests reproducible', async () => {
    expect(await hashJson(STEWARD_ACTIONS_SOURCE_INVENTORY))
      .toBe(STEWARD_ACTIONS_SOURCE_INVENTORY_DIGEST);
    expect(await hashJson(STEWARD_ACTIONS_EXECUTION_POLICIES))
      .toBe(STEWARD_ACTIONS_EXECUTION_POLICY_DIGEST);
  });
});
