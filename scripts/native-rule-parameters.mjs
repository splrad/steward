/** REST may omit UPDATE parameters; obtain the value from the same native ruleset node. */
export async function completeNativeRuleParameters(client, ruleset) {
  if (!Array.isArray(ruleset?.rules) || !ruleset.rules.some(rule => rule.type === 'update' && rule.parameters === undefined)) return ruleset;
  const check = (value, code) => { if (!value) throw Error('NATIVE_RULE_PARAMETERS_' + code); };
  check(typeof ruleset.node_id === 'string' && ruleset.node_id.length > 0, 'NODE');
  const result = await client.graphql(`query($id: ID!) {
    node(id: $id) { ... on RepositoryRuleset {
      id databaseId rules(first: 100) {
        nodes { type parameters { ... on UpdateParameters { updateAllowsFetchAndMerge } } }
        pageInfo { hasNextPage }
      }
    } }
  }`, { id: ruleset.node_id });
  const node = result?.node;
  check(node?.id === ruleset.node_id && node.databaseId === ruleset.id, 'IDENTITY');
  check(node.rules?.pageInfo?.hasNextPage === false && Array.isArray(node.rules.nodes), 'COMPLETE');
  const updates = node.rules.nodes.filter(rule => rule.type === 'UPDATE');
  check(updates.length === 1 && ruleset.rules.filter(rule => rule.type === 'update').length === 1, 'COUNT');
  const value = updates[0].parameters?.updateAllowsFetchAndMerge;
  check(typeof value === 'boolean', 'VALUE');
  return { ...ruleset, rules: ruleset.rules.map(rule => rule.type === 'update'
    ? { ...rule, parameters: { update_allows_fetch_and_merge: value } } : rule) };
}
