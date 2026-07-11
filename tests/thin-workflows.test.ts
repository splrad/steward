import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const stewardSha = '95569fa21765c3da030e5fefb628124cc2fd177b';
const repositoryRoot = new URL('../', import.meta.url);
const templatePaths = [
  'templates/thin-workflows/pr-classification.yml',
  'templates/thin-workflows/pr-governance.yml',
  'templates/thin-workflows/pr-review-signal.yml',
  'templates/thin-workflows/pr-validation-matrix.yml',
] as const;

async function templates(): Promise<Record<(typeof templatePaths)[number], string>> {
  return Object.fromEntries(await Promise.all(templatePaths.map(async (path) => [
    path,
    await readFile(new URL(path, repositoryRoot), 'utf8'),
  ]))) as Record<(typeof templatePaths)[number], string>;
}

describe('thin caller workflow templates', () => {
  it('pins one reusable workflow per caller and never executes repository code', async () => {
    for (const [path, source] of Object.entries(await templates())) {
      expect(source, path).toMatch(/^permissions:\r?\n  contents: read$/m);
      expect(source, path).not.toMatch(/^\s+[a-z-]+:\s*write$/m);
      expect(source, path).not.toContain('secrets: inherit');
      expect(source, path).not.toContain('actions/checkout');
      expect(source, path).not.toMatch(/^\s+(steps|run):/m);
      const uses = [...source.matchAll(/^\s+uses:\s+([^\s]+)$/gm)].map((match) => match[1]);
      expect(uses, path).toHaveLength(1);
      expect(uses[0], path).toMatch(new RegExp(`^splrad/steward/\\.github/workflows/[^@]+@${stewardSha}$`));
    }
  });

  it('keeps target run-name identity fixed and review signals credential-free', async () => {
    const files = await templates();
    const targetRunName = 'PR Validation Target #${{ github.event.pull_request.number || github.event.inputs.pr_number }} / ${{ github.event.pull_request.head.sha || github.event.inputs.head_sha }}';
    expect(files['templates/thin-workflows/pr-classification.yml']).toContain(targetRunName);
    expect(files['templates/thin-workflows/pr-governance.yml']).toContain(targetRunName);
    const signal = files['templates/thin-workflows/pr-review-signal.yml'];
    expect(signal).toContain('PR Review Signal #${{ github.event.pull_request.number }}');
    expect(signal).toContain('types: [review_requested, review_request_removed]');
    expect(signal).not.toContain('secrets:');
  });

  it('maps only named credentials and keeps Actions write inside the called Matrix workflow', async () => {
    const files = await templates();
    const classification = files['templates/thin-workflows/pr-classification.yml'];
    const governance = files['templates/thin-workflows/pr-governance.yml'];
    const matrix = files['templates/thin-workflows/pr-validation-matrix.yml'];
    for (const source of [classification, governance, matrix]) {
      expect(source).toContain('app_client_id: ${{ vars.WORKFLOW_AUTOMATION_APP_CLIENT_ID }}');
      expect(source).toContain('app_private_key: ${{ secrets.WORKFLOW_AUTOMATION_APP_PRIVATE_KEY }}');
      expect(source).not.toMatch(/^\s+actions:\s*write$/m);
    }
    expect(governance).toContain('copilot_review_request_token: ${{ secrets.COPILOT_REVIEW_REQUEST_TOKEN }}');
    expect(governance).toContain('core_auto_approval_token: ${{ secrets.CORE_AUTO_APPROVAL_TOKEN }}');
  });

  it('routes Matrix convergence events and ignores its own completed Check', async () => {
    const matrix = (await templates())['templates/thin-workflows/pr-validation-matrix.yml'];
    expect(matrix).toContain('workflow_run:');
    expect(matrix).toContain('repository_dispatch:');
    expect(matrix).toContain('check_run:');
    expect(matrix).toContain('PR Validation Matrix Gate');
    expect(matrix).toContain('Evaluate PR Validation Matrix');
    expect(matrix).toContain("github.event.action == 'rerequested'");
    expect(matrix).toContain("pr_number: ${{ fromJSON(github.event.inputs.pr_number || '0') }}");
    expect(matrix).toContain("head_sha: ${{ github.event.inputs.head_sha || '' }}");
  });

  it('does not expose Manifest policy as caller inputs', async () => {
    const source = Object.values(await templates()).join('\n');
    expect(source).not.toMatch(/\$\{\{\s*inputs\./);
    for (const forbidden of [
      'trusted_developers', 'labels:', 'paths:', 'check_name', 'workflow_file', 'maintainers:', 'account:',
    ]) expect(source).not.toContain(forbidden);
  });
});
