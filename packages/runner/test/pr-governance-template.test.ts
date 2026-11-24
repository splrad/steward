import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import YAML from 'yaml';

async function template(name:string) {
  return YAML.parse(await readFile(`templates/repository/.github/workflows/${name}.yml`,'utf8'));
}

it('reports the unprefixed title check from the actual shared workflow result',async()=>{
  const source=await readFile('templates/repository/.github/workflows/pr-title.yml.jinja','utf8');
  const sha='a'.repeat(40);
  const workflow=YAML.parse(source.replace('{{ _copier_conf.vcs_ref_hash }}',sha));
  expect(workflow.on).toEqual({pull_request:{types:['opened','edited','synchronize','reopened']}});
  expect(workflow.permissions).toEqual({'pull-requests':'read'});
  expect(workflow.jobs.semantic.uses).toBe(`splrad/steward/.github/workflows/pr-title-reusable.yml@${sha}`);
  expect(workflow.jobs.semantic.secrets).toBeUndefined();
  expect(workflow.jobs.title).toMatchObject({
    name:'SPLRAD PR Title',
    needs:'semantic',
    if:'always()',
    steps:[
      {if:"always() && needs.semantic.result == 'success'",run:'exit 0'},
      {if:"always() && needs.semantic.result != 'success'",run:'exit 1'},
    ],
  });
});

it('uses the pull request event metadata for labels without checking out or executing its files',async()=>{
  const workflow=await template('pr-labeler');
  expect(workflow.on).toEqual({pull_request_target:{types:['opened','edited','synchronize','reopened']}});
  expect(workflow.permissions).toEqual({contents:'read','pull-requests':'write'});
  expect(workflow.concurrency.group).toContain('github.event.pull_request.number');
  expect(workflow.jobs.labels.steps).toHaveLength(1);
  const [step]=workflow.jobs.labels.steps;
  expect(step.uses).toMatch(/^actions\/labeler@[a-f0-9]{40}$/);
  expect(step.run).toBeUndefined();
  expect(step.with).toEqual({
    'repo-token':'${{ github.token }}',
    'sync-labels':true,
    'configuration-path':'.github/labeler.yml',
  });
});
