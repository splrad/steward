// Shared interpretation of the central required-workflow binding.
export function requiredWorkflowBinding(body,code='PROMOTION_BINDING') {
  const check=value=>{if(!value)throw Error(code);};
  const rules=body.rules.filter(r=>r.type==='workflows');
  check(rules.length===1&&Array.isArray(rules[0].parameters?.workflows));
  const rows=rules[0].parameters.workflows.filter(r=>r.repository_id===1296724484&&r.path==='.github/workflows/pr-validation-native.yml');
  check(rows.length===1&&typeof rows[0].sha==='string'&&/^[a-f0-9]{40}$/.test(rows[0].sha)&&!Object.hasOwn(rows[0],'ref'));
  return rows[0];
}
