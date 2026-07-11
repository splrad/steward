import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const actionSha = 'dd0faabda91ca5dcd8d8d6dd3894bfe2665ab8b0';
const appTokenSha = 'bcd2ba49218906704ab6c1aa796996da409d3eb1';
const workflowPaths = [
  '.github/workflows/pr-governance.yml',
  '.github/workflows/pr-review-signal.yml',
  '.github/workflows/pr-validation-matrix.yml',
] as const;

async function workflows(): Promise<Record<(typeof workflowPaths)[number], string>> {
  return Object.fromEntries(await Promise.all(workflowPaths.map(async (path) => [path, await readFile(path, 'utf8')]))) as Record<
    (typeof workflowPaths)[number], string
  >;
}

describe('First reusable workflow contracts', () => {
  it('exposes called workflows only and pins every external action to a complete SHA', async () => {
    const files = await workflows();
    for (const [path, source] of Object.entries(files)) {
      expect(source, path).toMatch(/^on:\r?\n  workflow_call:/m);
      expect(source, path).not.toMatch(/^  (pull_request|pull_request_target|workflow_run|repository_dispatch|schedule|workflow_dispatch):/m);
      for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
        expect(match[1], `${path}: ${match[1]}`).toMatch(/@[0-9a-f]{40}$/);
      }
      expect(source, path).not.toContain('secrets: inherit');
      expect(source, path).not.toMatch(/^\s*environment:/m);
    }
    expect(files['.github/workflows/pr-governance.yml']).toContain(`splrad/steward/action@${actionSha}`);
    expect(files['.github/workflows/pr-validation-matrix.yml']).toContain(`splrad/steward/action@${actionSha}`);
    expect(`${files['.github/workflows/pr-governance.yml']}\n${files['.github/workflows/pr-validation-matrix.yml']}`)
      .toContain(`actions/create-github-app-token@${appTokenSha}`);
  });

  it('gates optional human credentials from the trusted Manifest preflight', async () => {
    const governance = (await workflows())['.github/workflows/pr-governance.yml'];
    expect(governance).toContain('operation: governance-preflight');
    expect(governance).toContain("needs.preflight.outputs.governance_enabled == 'true'");
    expect(governance).toContain("needs.preflight.outputs.copilot_review_enabled == 'true'");
    expect(governance).toContain('mutation-token: ${{ secrets.copilot_review_request_token }}');
    expect(governance).toContain('mutation-token: ${{ secrets.core_auto_approval_token }}');
    expect(governance.match(/mutation-token:/g)).toHaveLength(2);
    expect(governance.match(/needs\.preflight\.outputs\.governance_enabled == 'true'/g)).toHaveLength(1);
    expect(governance.match(/needs\.preflight\.outputs\.copilot_review_enabled == 'true'/g)).toHaveLength(1);
    expect(governance).toContain('name: Main Authorization Gate');
    expect(governance).toContain('name: Update Copilot Review Check');
    expect(governance).toContain('cancel-in-progress: false');
  });

  it('keeps review signal metadata fixed, validated, and credential-free', async () => {
    const signal = (await workflows())['.github/workflows/pr-review-signal.yml'];
    expect(signal).toContain('pull_request:review_requested|pull_request:review_request_removed');
    expect(signal).toContain('pull_request_review_thread:resolved|pull_request_review_thread:unresolved');
    expect(signal).toContain('Review signal PR number must be a positive integer');
    expect(signal).toContain('name: Record Review State Change');
    expect(signal).not.toMatch(/^\s*uses:/m);
    expect(signal).not.toContain('secrets:');
  });

  it('records the caller-owned path and run-name trust boundary', async () => {
    const contract = await readFile('docs/reusable-workflows.md', 'utf8');
    expect(contract).toContain('.github/workflows/pr-governance.yml');
    expect(contract).toContain('PR Validation Target #<PR> / <40-character-head-SHA> / <scope>');
    expect(contract).toContain('.github/workflows/pr-review-signal.yml');
    expect(contract).toContain('PR Review Signal #<PR> / <40-character-head-SHA> / <source-event> / <source-action>');
    expect(contract).toContain('does not replace the caller\'s trigger, file identity, or `run-name`');
  });

  it('confines Actions-write to Matrix while all called workflows keep GITHUB_TOKEN read-only', async () => {
    const files = await workflows();
    const actionsWriters = Object.entries(files).filter(([, source]) => source.includes('permission-actions: write'));
    expect(actionsWriters.map(([path]) => path)).toEqual(['.github/workflows/pr-validation-matrix.yml']);
    for (const [path, source] of Object.entries(files)) {
      expect(source, path).toMatch(/^permissions:\r?\n  contents: read$/m);
      expect(source, path).not.toMatch(/^\s+actions:\s*write$/m);
    }
    const matrix = files['.github/workflows/pr-validation-matrix.yml'];
    expect(matrix).toContain('name: Evaluate PR Validation Matrix');
    expect(matrix).toContain('permission-checks: write');
    expect(matrix).toContain('cancel-in-progress: true');
  });

  it('does not expose project policy through called workflow inputs', async () => {
    const source = Object.values(await workflows()).join('\n');
    for (const forbidden of [
      'trusted_developers', 'labels:', 'paths:', 'check_name', 'workflow_file', 'maintainers:', 'account:',
    ]) expect(source).not.toContain(forbidden);
  });
});
