import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const actionSha = 'cd874ad2819bb1a24b4af17b6a5108b56fb728b9';
const appTokenSha = 'bcd2ba49218906704ab6c1aa796996da409d3eb1';
const releaseActionSha = '6e33424e7fb18100145845b49e8ccf2c90d504e0';
const repositoryRoot = new URL('../', import.meta.url);
const workflowPaths = [
  '.github/workflows/pr-classification.yml',
  '.github/workflows/pr-governance.yml',
  '.github/workflows/pr-review-signal.yml',
  '.github/workflows/pr-validation-matrix.yml',
  '.github/workflows/release.yml',
] as const;

async function workflows(): Promise<Record<(typeof workflowPaths)[number], string>> {
  return Object.fromEntries(await Promise.all(workflowPaths.map(async (path) => [
    path,
    await readFile(new URL(path, repositoryRoot), 'utf8'),
  ]))) as Record<
    (typeof workflowPaths)[number], string
  >;
}

describe('First reusable workflow contracts', () => {
  it('exposes called workflows only and pins every uses reference to a complete SHA', async () => {
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
    expect(files['.github/workflows/pr-validation-matrix.yml']).toContain(
      `splrad/steward/action@${actionSha}`,
    );
    expect(files['.github/workflows/pr-classification.yml']).toContain(
      `splrad/steward/action@${actionSha}`,
    );
    expect(`${files['.github/workflows/pr-governance.yml']}\n${files['.github/workflows/pr-validation-matrix.yml']}`)
      .toContain(`actions/create-github-app-token@${appTokenSha}`);
    expect(files['.github/workflows/release.yml']).toContain(`splrad/steward/action@${releaseActionSha}`);
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
    expect(signal).toContain("printf 'Rejected review signal: %q\\n'");
    expect(signal).toContain('name: Record Review State Change');
    expect(signal).not.toMatch(/^\s*uses:/m);
    expect(signal).not.toContain('secrets:');
  });

  it('records the caller-owned path and run-name trust boundary', async () => {
    const contract = await readFile(new URL('docs/reusable-workflows.md', repositoryRoot), 'utf8');
    expect(contract).toContain('.github/workflows/pr-classification.yml');
    expect(contract).toContain('PR Validation Target #<PR> / <40-character-head-SHA>');
    expect(contract).toContain('.github/workflows/pr-governance.yml');
    expect(contract).not.toContain('PR Validation Target #<PR> / <40-character-head-SHA> / <scope>');
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
    const concurrency = matrix.match(/concurrency:\r?\n\s+group: >-[\s\S]*?\r?\n\s+cancel-in-progress: true/)?.[0];
    expect(matrix).toContain('name: Evaluate PR Validation Matrix');
    expect(matrix).toContain('permission-checks: write');
    expect(matrix).toContain('cancel-in-progress: true');
    expect(concurrency).toBeDefined();
    expect(concurrency).toContain('github.event.pull_request.number');
    expect(concurrency).toContain("startsWith(github.event.workflow_run.display_title, 'PR Validation Target #')");
    expect(concurrency).toContain("startsWith(github.event.workflow_run.display_title, 'PR Review Signal #')");
    expect(concurrency).toContain('&& github.event.workflow_run.display_title');
    expect(concurrency).toContain("startsWith(github.event.workflow_run.name, 'PR Validation Target #')");
    expect(concurrency).toContain('&& github.event.workflow_run.name');
    expect(concurrency).toContain('|| github.event.workflow_run.pull_requests[0].number');
    expect(concurrency).toContain('|| inputs.pr_number');
    expect(concurrency).toContain('|| github.run_id');
    expect(matrix).not.toContain('group: steward-matrix-${{ github.repository_id }}-${{ inputs.pr_number }}');
    expect(concurrency!.indexOf('github.event.pull_request.number')).toBeLessThan(concurrency!.indexOf('inputs.pr_number'));
    expect(concurrency!.indexOf('github.event.workflow_run.display_title'))
      .toBeLessThan(concurrency!.indexOf('github.event.workflow_run.pull_requests[0].number'));
    expect(concurrency!.indexOf('github.event.workflow_run.name'))
      .toBeLessThan(concurrency!.indexOf('github.event.workflow_run.pull_requests[0].number'));
    expect(concurrency!.indexOf('github.event.workflow_run.display_title')).toBeLessThan(concurrency!.indexOf('inputs.pr_number'));
    expect(matrix).toMatch(/pr_number:\r?\n\s+description:[^\r\n]+\r?\n\s+required: false\r?\n\s+default: 0/);
    expect(matrix).toMatch(/head_sha:\r?\n\s+description:[^\r\n]+\r?\n\s+required: false\r?\n\s+default: ''/);
  });

  it('gives Classification only its fixed App-token mutations and no caller policy surface', async () => {
    const classification = (await workflows())['.github/workflows/pr-classification.yml'];
    expect(classification).toContain('name: Classify Pull Request');
    expect(classification).toContain('operation: classification');
    expect(classification).toContain('permission-checks: write');
    expect(classification).toContain('permission-contents: read');
    expect(classification).toContain('permission-issues: write');
    expect(classification).toContain('permission-pull-requests: write');
    expect(classification).toContain('cancel-in-progress: true');
    expect(classification).not.toContain('mutation-token:');
    expect(classification).not.toContain('actions/checkout');
    expect(classification.match(/^\s*uses:/gm)).toHaveLength(2);
  });

  it('does not expose project policy through called workflow inputs', async () => {
    const source = Object.values(await workflows()).join('\n');
    for (const forbidden of [
      'trusted_developers', 'labels:', 'paths:', 'check_name', 'workflow_file', 'maintainers:', 'account:',
    ]) expect(source).not.toContain(forbidden);
  });

  it('orchestrates Release from trusted Manifest outputs and finalizes failures before publication', async () => {
    const release = (await workflows())['.github/workflows/release.yml'];
    expect(release).toContain('operation: release-preflight');
    expect(release).toContain('continue-on-error: true');
    expect(release).toContain("steps.steward.outcome == 'failure'");
    expect(release).toContain('runs-on: ${{ needs.preflight.outputs.release_runner }}');
    expect(release).toContain('fromJSON(needs.preflight.outputs.release_context).pullRequest.mergeSha');
    expect(release).toContain('release-adapter-phase: plan');
    expect(release).toContain('operation: release-status');
    expect(release).toContain('operation: release-reconcile');
    expect(release).toContain("steps.status.outputs['release-build-needed'] != 'true'");
    expect(release).toContain("steps.status.outputs['release-build-needed'] == 'true'");
    expect(release).toContain('release-adapter-phase: build');
    expect(release).toContain('operation: release-publish');
    expect(release.match(/operation: release-finalize/g)).toHaveLength(2);
    expect(release).toContain('always() && (');
    expect(release).toContain("steps.build.outcome == 'failure'");
    expect(release).toContain("steps.reconcile.outcome == 'failure'");
    expect(release).toContain('permission-contents: write');
    expect(release).toContain('permission-checks: write');
    expect(release).toContain('cancel-in-progress: false');
  });
});
