// Fixed command capabilities; workflow names and surrounding business jobs are not identities.
export function miseSetup(directory: string) {
 return {uses:'jdx/mise-action@82a612c5ab8bcda7cc5db6b7e81a8e7584c3dc6e',
  env:{MISE_SAFE:'1',MISE_NODE_COMPILE:'false'},
  with:{version:'2026.10.18',install_args:'--locked',working_directory:directory,cache:false,env:false,persist_github_token:false}};
}
const policySourceOperations:readonly unknown[] = [
  {
    "env": {
      "APP_ID": "4243096",
      "INSTALLATION_ID": "145952003",
      "STEWARD_APP_PRIVATE_KEY": "${{ secrets.STEWARD_APP_PRIVATE_KEY }}",
      "REPOSITORY_ID": "${{ inputs.repositoryId }}",
      "POLICY_SHA": "${{ steps.policy.outputs.policy_sha }}",
      "SYNC_TRIGGER": "${{ github.event_name }}",
      "TRIGGER_ACTOR_ID": "${{ github.actor_id }}",
      "TRIGGER_ACTOR_LOGIN": "${{ github.actor }}"
    },
    "run": "repository_arguments=()\nif [[ -n \"$REPOSITORY_ID\" ]]; then\n  repository_arguments+=(--repository-id \"$REPOSITORY_ID\")\nfi\nnode packages/runner/dist/index.js sync-managed-labels \"${repository_arguments[@]}\" --policy-sha \"$POLICY_SHA\"\n",
    "working-directory": "policy-live"
  },
  {
    "id": "targets",
    "shell": "bash",
    "env": {
      "APP_ID": "4243096",
      "INSTALLATION_ID": "145952003",
      "STEWARD_APP_PRIVATE_KEY": "${{ secrets.STEWARD_APP_PRIVATE_KEY }}",
      "REPOSITORY_ID": "${{ inputs.repositoryId }}",
      "POLICY_SHA": "${{ steps.policy.outputs.policy_sha }}",
      "SYNC_TRIGGER": "${{ github.actor_id == '301115370' && 'app-redrive' || github.event_name }}",
      "TRIGGER_ACTOR_ID": "${{ github.actor_id }}",
      "TRIGGER_ACTOR_LOGIN": "${{ github.actor }}"
    },
    "run": "repository_arguments=()\nif [[ -n \"$REPOSITORY_ID\" ]]; then\n  repository_arguments+=(--repository-id \"$REPOSITORY_ID\")\nfi\nnode packages/runner/dist/index.js review-sync-targets \"${repository_arguments[@]}\" --policy-sha \"$POLICY_SHA\"\n",
    "working-directory": "policy-live"
  },
  {
    "shell": "bash",
    "env": {
      "APP_ID": "4243096",
      "INSTALLATION_ID": "145952003",
      "STEWARD_APP_PRIVATE_KEY": "${{ secrets.STEWARD_APP_PRIVATE_KEY }}",
      "RUNTIME_URL": "https://splrad-steward-runtime.alearner-5ef.workers.dev",
      "REPOSITORY_ID": "${{ matrix.repositoryId }}",
      "POLICY_SHA": "${{ steps.policy.outputs.policy_sha }}",
      "SYNC_TRIGGER": "${{ github.actor_id == '301115370' && 'app-redrive' || github.event_name }}",
      "TRIGGER_ACTOR_ID": "${{ github.actor_id }}",
      "TRIGGER_ACTOR_LOGIN": "${{ github.actor }}"
    },
    "run": "repository_arguments=()\nif [[ -n \"$REPOSITORY_ID\" ]]; then\n  repository_arguments+=(--repository-id \"$REPOSITORY_ID\")\nfi\nnode packages/runner/dist/index.js sync-review-instructions \"${repository_arguments[@]}\" --policy-sha \"$POLICY_SHA\"\n",
    "working-directory": "policy-live"
  }
];
/** This prefix executes only the workflow's immutable source, then resolves the live policy. */
export const policySourcePrefix = [
 {uses:'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',with:{ref:'${{ github.workflow_sha }}',path:'policy-bootstrap','persist-credentials':false}},
 miseSetup('policy-bootstrap'),
 {id:'policy',name:'解析已部署规则提交',run:'node policy-bootstrap/packages/runner/dist/index.js trusted-policy-source',env:{POLICY_SOURCE_READ_TOKEN:'${{ github.token }}',POLICY_SOURCE_RUN_ID:'${{ github.event.workflow_run.id }}'}},
 {uses:'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',with:{ref:'${{ steps.policy.outputs.policy_sha }}','persist-credentials':false,path:'policy-live'}},
 miseSetup('policy-live'),
 {run:'npm ci --ignore-scripts','working-directory':'policy-live'},
];
export function hasTrustedPolicyPrefix(d: any,j:any): boolean {
 const stable=(v:any):string=>v && typeof v==='object'?JSON.stringify(Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))]))):JSON.stringify(v);
 if(d.env!==undefined || d.defaults!==undefined || j.env!==undefined || j.defaults!==undefined || j['continue-on-error']!==undefined)return false;
 const expected:any=structuredClone(policySourcePrefix);
 if(j.needs==='resolve')expected[2].env.POLICY_SOURCE_EXPECTED_SHA='${{ needs.resolve.outputs.policy_sha }}';
 if(stable(j.steps?.slice(0,policySourcePrefix.length))!==stable(expected))return false;
 if(j.steps.length!==policySourcePrefix.length+1)return false;
 const operation=structuredClone(j.steps[policySourcePrefix.length]);delete operation.name;
 return policySourceOperations.some(expected=>stable(operation)===stable(expected));
}
export function assertArtifactHandoff(d:any): void {
 const fail=()=>{throw new Error('WORKFLOW_POLICY: isolated artifact handoff changed');};
 for(const job of Object.values(d.jobs) as any[])for(const step of job.steps??[]) {
  if(!step.run?.includes('release-build --operation accept'))continue;
  const match=/^\$\{\{ needs\.([A-Za-z_][\w-]*)\.outputs\.report \}\}$/.exec(step.env?.ARTIFACT_REPORT??'');if(!match)fail();
  const name=match![1]!,inspection=d.jobs[name];
  if(!inspection || inspection.environment!==undefined || inspection.env!==undefined || inspection.defaults!==undefined || inspection['continue-on-error']!==undefined || !Array.isArray(job.needs) || !job.needs.includes(name) || !job.if?.includes(`needs.${name}.result == 'success'`))fail();
  const clean=structuredClone(inspection.steps);for(const s of clean)delete s.name;
  const expected=[
   {uses:'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',with:{ref:'${{ github.workflow_sha }}','persist-credentials':false}},
   miseSetup('.'),
   {run:'npm ci --ignore-scripts'},
   {id:'inspection',shell:'pwsh',env:{POLICY_SHA:'${{ github.workflow_sha }}',ARTIFACT_READ_TOKEN:'${{ github.token }}',ARTIFACT_BINDING:'${{ needs.resolve.outputs.binding }}',BUILD_PLAN:'${{ needs.resolve.outputs.plan }}'},run:'node packages/runner/dist/index.js release-build --operation inspect-artifact --policy-sha "$env:POLICY_SHA" --inspector scripts/inspect-native-release.ps1'}
  ];
  const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  if(canonical(clean)!==canonical(expected) || inspection.needs!=='resolve' || inspection['timeout-minutes']!==360 || inspection.outputs?.report!=='${{ steps.inspection.outputs.report }}')fail();
 }
}
