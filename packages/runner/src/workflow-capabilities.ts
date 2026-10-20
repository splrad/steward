/** This prefix executes only the workflow's immutable source, then resolves the live policy. */
export const policySourcePrefix = [
 {uses:'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',with:{ref:'${{ github.workflow_sha }}',path:'policy-bootstrap','persist-credentials':false}},
 {uses:'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',with:{'node-version-file':'policy-bootstrap/.node-version'}},
 {id:'policy',name:'解析已部署规则提交',run:'node policy-bootstrap/packages/runner/dist/index.js trusted-policy-source',env:{POLICY_SOURCE_READ_TOKEN:'${{ github.token }}',POLICY_SOURCE_RUN_ID:'${{ github.event.workflow_run.id }}'}},
 {uses:'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',with:{ref:'${{ steps.policy.outputs.policy_sha }}','persist-credentials':false,path:'policy-live'}},
 {uses:'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',with:{'node-version-file':'policy-live/.node-version'}},
 {run:'npm ci --ignore-scripts','working-directory':'policy-live'},
];
export function hasTrustedPolicyPrefix(d: any,j:any): boolean {
 const stable=(v:any):string=>v && typeof v==='object'?JSON.stringify(Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))]))):JSON.stringify(v);
 if(d.env!==undefined || d.defaults!==undefined || j.env!==undefined || j.defaults!==undefined || j['continue-on-error']!==undefined)return false;
 const expected:any=structuredClone(policySourcePrefix);
 if(j.needs==='resolve')expected[2].env.POLICY_SOURCE_EXPECTED_SHA='${{ needs.resolve.outputs.policy_sha }}';
 if(stable(j.steps?.slice(0,policySourcePrefix.length))!==stable(expected))return false;
 return j.steps.slice(policySourcePrefix.length).every((s:any)=> !s.uses && typeof s.run==='string' && s['working-directory']==='policy-live' && s.env?.POLICY_SHA==='${{ steps.policy.outputs.policy_sha }}');
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
   {uses:'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',with:{'node-version-file':'.node-version',cache:'npm'}},
   {run:'npm ci --ignore-scripts'},
   {id:'inspection',shell:'pwsh',env:{POLICY_SHA:'${{ github.workflow_sha }}',ARTIFACT_READ_TOKEN:'${{ github.token }}',ARTIFACT_BINDING:'${{ needs.resolve.outputs.binding }}',BUILD_PLAN:'${{ needs.resolve.outputs.plan }}'},run:'node packages/runner/dist/index.js release-build --operation inspect-artifact --policy-sha "$env:POLICY_SHA" --inspector scripts/inspect-native-release.ps1'}
  ];
  const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  if(canonical(clean)!==canonical(expected) || inspection.needs!=='resolve' || inspection.outputs?.report!=='${{ steps.inspection.outputs.report }}')fail();
 }
}
