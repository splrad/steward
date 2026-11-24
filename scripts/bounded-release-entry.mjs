const central='splrad/steward',centralId=1296724484;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const fail=reason=>{throw Error(reason);};
export async function entryGuard(env,get,config) {
  if(config.enabled!==true||!sha(config.deploymentSha))fail('BOUNDED_NOT_CONNECTED');
  if(env.GITHUB_REPOSITORY!==central||env.GITHUB_REPOSITORY_ID!==String(centralId)||env.GITHUB_REF!=='refs/heads/main'
    ||!sha(env.STEWARD_CONTROLLER_SHA))fail('BOUNDED_ENTRY_SOURCE');
  const workflow={cycle:'.github/workflows/release-cycle-event.yml',pages:'.github/workflows/pages-maintenance-event.yml',normal:'.github/workflows/release-candidate-event.yml'}[env.BOUNDED_MODE];
  if(!workflow)fail('BOUNDED_MODE');
  const repo=await get(`/repos/${central}`),head=await get(`/repos/${central}/git/ref/heads/main`);
  const run=await get(`/repos/${central}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`);
  if(repo.id!==centralId||repo.default_branch!=='main'||head.object?.sha!==env.STEWARD_CONTROLLER_SHA||repo.archived||repo.disabled
    ||run.id!==Number(env.GITHUB_RUN_ID)||run.run_attempt!==Number(env.GITHUB_RUN_ATTEMPT)||run.repository?.id!==centralId||run.head_repository?.id!==centralId
    ||run.path!==workflow||run.head_sha!==env.STEWARD_CONTROLLER_SHA||run.head_branch!=='main'
    ||run.event!==('workflow_dispatch'))fail('BOUNDED_RUN_SOURCE');
  const own=await get(`/repos/${central}/actions/workflows/${workflow.split('/').at(-1)}`);
  if(!Number.isSafeInteger(own.id)||own.id<1||own.path!==workflow||own.state!=='active'||run.workflow_id!==own.id)fail('BOUNDED_ENTRY_DISABLED');
  if((await get(`/repos/${central}/git/ref/heads/main`))?.object?.sha!==head.object.sha)fail('BOUNDED_RUN_SOURCE');
  return run;
}
