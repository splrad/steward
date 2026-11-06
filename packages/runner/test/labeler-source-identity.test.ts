import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import YAML from 'yaml';

const repository = {id: 10, full_name: 'example/base'};
const sourceRepository = {id: 20, full_name: 'contributor/fork'};
const source = {
  id: 100, workflow_id: 200, path: '.github/workflows/pr-title.yml',
  event: 'pull_request_target', repository, head_repository: sourceRepository,
  head_sha: 'a'.repeat(40), head_branch: 'contribution', status: 'completed', run_attempt: 2,
};
const pull = {
  number: 1, state: 'open', base: {repo: repository},
  head: {repo: sourceRepository, sha: source.head_sha, ref: source.head_branch},
};
const workflow = YAML.parse(readFileSync('templates/repository/.github/workflows/pr-labeler.yml', 'utf8'));
const shell = workflow.jobs.labels.steps.find((step: {id?: string}) => step.id === 'target').run as string;
const heredoc = shell.split("node --input-type=module <<'NODE'\n")[1]?.split('\nNODE')[0];
if (!heredoc) throw new Error('Missing labeler resolver script');
const script = heredoc.replace(/^import .*;\r?\n/gm, '');

function resolveTarget({run = source, listed = [pull], reread = pull, attempt = 2} = {}) {
  let output = '';
  const api = (_command: string, args: string[]) => {
    const path = args.at(-1)!;
    if (path.endsWith('/actions/workflows/pr-title.yml')) return JSON.stringify({id: source.workflow_id, path: source.path});
    if (path.endsWith('/actions/runs/100')) return JSON.stringify(run);
    if (path.includes('/pulls?')) return JSON.stringify([listed]);
    if (/\/pulls\/\d+$/.test(path)) return JSON.stringify(reread);
    throw new Error(`UNEXPECTED_API:${path}`);
  };
  const process = {env: {
    GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: repository.full_name,
    GITHUB_REPOSITORY_ID: String(repository.id), GITHUB_EVENT_PATH: 'event', GITHUB_OUTPUT: 'output',
  }};
  const event = {action: 'completed', workflow_run: {id: source.id, run_attempt: attempt}};
  new Function('execFileSync', 'appendFileSync', 'readFileSync', 'process', 'console', script)(
    api, (_path: string, text: string) => { output += text; }, () => JSON.stringify(event), process, {log() {}},
  );
  return output;
}

it('resolves the current fork PR from the native run repository identity', () => {
  expect(resolveTarget()).toBe('number=1\nreason=CURRENT_PR\n');
});

it('does not substitute another fork sharing the same commit and branch after the original PR closes', () => {
  const other = {...pull, number: 2, head: {...pull.head, repo: {id: 30, full_name: 'another/fork'}}};
  expect(resolveTarget({listed: [other], reread: other})).toBe('number=\nreason=PR_NOT_CURRENT_OR_OPEN\n');
  expect(resolveTarget({listed: [other, pull]})).toBe('number=1\nreason=CURRENT_PR\n');
});

it('checks source repository identity again after pagination', () => {
  const changed = {...pull, head: {...pull.head, repo: {id: 30, full_name: 'another/fork'}}};
  expect(resolveTarget({reread: changed})).toBe('number=\nreason=PR_NOT_CURRENT_OR_OPEN\n');
});

it('rejects a missing or invalid native source repository ID', () => {
  for (const id of [undefined, null, 0, -1, '20']) {
    expect(() => resolveTarget({run: {...source, head_repository: {id, full_name: 'contributor/fork'}} as typeof source}))
      .toThrow('LABELER_SOURCE_IDENTITY');
  }
});

it('also supports a PR whose head is in the base repository', () => {
  const sameRepository = {...pull, head: {...pull.head, repo: repository}};
  expect(resolveTarget({run: {...source, head_repository: repository}, listed: [sameRepository], reread: sameRepository}))
    .toBe('number=1\nreason=CURRENT_PR\n');
});

it('still rejects stale heads, closed PRs, and superseded attempts', () => {
  expect(resolveTarget({listed: [{...pull, head: {...pull.head, sha: 'b'.repeat(40)}}]}))
    .toBe('number=\nreason=PR_NOT_CURRENT_OR_OPEN\n');
  expect(resolveTarget({listed: [{...pull, state: 'closed'}]})).toBe('number=\nreason=PR_NOT_CURRENT_OR_OPEN\n');
  expect(resolveTarget({attempt: 1})).toBe('number=\nreason=SOURCE_ATTEMPT_MOVED\n');
});

it('still fails closed if one source identity matches multiple open PRs', () => {
  expect(() => resolveTarget({listed: [pull, {...pull, number: 2}]})).toThrow('LABELER_PR_AMBIGUOUS');
});
