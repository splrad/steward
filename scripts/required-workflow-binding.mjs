export const validatorRuleset = 18883080;
export const validatorRepository = 'splrad/steward';
export const validatorPath = '.github/workflows/pr-validation-native.yml';
export const validatorCommit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function requiredWorkflowBinding(body,code='PROMOTION_BINDING') {
  const check=value=>{if(!value)throw Error(code);};
  const rules=body.rules.filter(r=>r.type==='workflows');
  check(rules.length===1&&Array.isArray(rules[0].parameters?.workflows));
  const rows=rules[0].parameters.workflows.filter(r=>r.repository_id===1296724484&&r.path===validatorPath);
  check(rows.length===1&&validatorCommit(rows[0].sha)&&!Object.hasOwn(rows[0],'ref'));
  return rows[0];
}

export function effectiveValidator(rules,{optional=false,code='VALIDATOR_EFFECTIVE_BINDING'}={}) {
  const scope=rules.filter(rule=>rule.ruleset_id===validatorRuleset);
  if(optional&&!scope.length)return null;
  if(!scope.length||scope.some(rule=>rule.ruleset_source!=='splrad'||rule.ruleset_source_type!=='Organization'))
    throw Error(code);
  return requiredWorkflowBinding({rules:scope},code).sha;
}

export async function validatorRunSource(graphql,run) {
  const answer=await graphql('query($id:ID!){node(id:$id){... on WorkflowRun{file{path repositoryFileUrl}}}}',{id:run.node_id});
  const file=answer?.node?.file;
  const prefix=`https://github.com/${validatorRepository}/blob/`,suffix='/'+validatorPath;
  if(!file||typeof file.repositoryFileUrl!=='string')throw Error('VALIDATOR_RUN_SOURCE_UNAVAILABLE');
  if(file.path!==validatorPath||!file.repositoryFileUrl.startsWith(prefix)||!file.repositoryFileUrl.endsWith(suffix))return null;
  const source=file.repositoryFileUrl.slice(prefix.length,-suffix.length);
  return validatorCommit(source)?source:null;
}

export function sameValidationHead(run,pr) {
  return run.path===validatorPath&&run.event==='pull_request'&&run.repository?.id===pr.base.repo?.id
    &&run.head_repository?.id===pr.head.repo?.id&&run.head_sha===pr.head.sha&&run.head_branch===pr.head.ref;
}

export function matchesValidationPull(run,pr) {
  if(!sameValidationHead(run,pr))return false;
  if(run.pull_requests?.length)return run.pull_requests.some(row=>row.number===pr.number
    &&row.base?.repo?.id===pr.base.repo.id&&row.base?.ref===pr.base.ref
    &&row.head?.repo?.id===pr.head.repo.id&&row.head?.sha===pr.head.sha&&row.head?.ref===pr.head.ref);
  return run.display_title===`Native validation PR ${pr.number} / ${pr.head.sha} / ${pr.base.ref}`;
}
