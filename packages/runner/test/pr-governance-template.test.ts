import {readFile} from 'node:fs/promises';
import {minimatch} from 'minimatch';
import {expect,it} from 'vitest';
import YAML from 'yaml';

const titleTemplate='templates/repository/.github/workflows/pr-title.yml.jinja';
const titleProvider='.github/workflows/pr-title-reusable.yml';

async function template(name:string) {
  return YAML.parse(await readFile(`templates/repository/.github/workflows/${name}.yml`,'utf8'));
}

it('reports the unprefixed title check from the actual shared workflow result',async()=>{
  const source=await readFile(titleTemplate,'utf8');
  const sha='a'.repeat(40);
  const workflow=YAML.parse(source.replace('{{ _copier_conf.vcs_ref_hash }}',sha));
  const shared=YAML.parse(await readFile(titleProvider,'utf8'));
  for (const job of [workflow.jobs.title,shared.jobs.title]) {
    const image=job['runs-on'];
    expect(image).toMatch(/^ubuntu-\d{2}\.\d{2}$/);
    // Both jobs support later Ubuntu images proposed by Renovate.
    expect(image.localeCompare('ubuntu-26.04','en',{numeric:true})).toBeGreaterThanOrEqual(0);
  }
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

it('lets Renovate update the shared runner sources and leaves generated workflows to Copier',async()=>{
  const config=JSON.parse(await readFile('.github/renovate.json','utf8'));
  expect(config.enabledManagers).toContain('github-actions');
  // The provider is a standard workflow. The Jinja source needs an explicit match.
  expect(config['github-actions'].managerFilePatterns).toContain(titleTemplate);
  const runnerRule=config.packageRules.find((rule:{matchDepTypes?:string[],matchManagers?:string[],enabled?:boolean})=>
    rule.enabled && rule.matchManagers?.includes('github-actions') && rule.matchDepTypes?.includes('github-runner'));
  const ignored=(file:string)=>config.ignorePaths.some((pattern:string)=>
    file.includes(pattern) || minimatch(file,pattern,{dot:true}));
  for (const file of [titleProvider,titleTemplate,'templates/repository/.github/workflows/pr-labeler.yml']) {
    expect(ignored(file)).toBe(false);
    expect(runnerRule?.matchFileNames.some((pattern:string)=>minimatch(file,pattern,{dot:true}))).toBe(true);
  }
  expect(ignored('.github/workflows/pr-title.yml')).toBe(true);
  expect(ignored('.github/workflows/pr-labeler.yml')).toBe(true);
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
