import {expect,it} from 'vitest';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const module=()=>import(pathToFileURL(resolve('scripts/native-rule-parameters.mjs')).href);
const rule={id:12,node_id:'RRS_fixture',rules:[{type:'creation'},{type:'update'}]};
const graph=(value:boolean)=>({node:{id:rule.node_id,databaseId:rule.id,rules:{nodes:[{type:'CREATION',parameters:null},{type:'UPDATE',parameters:{updateAllowsFetchAndMerge:value}}],pageInfo:{hasNextPage:false}}}});
it.each([false,true])('retains the actual native UPDATE permission %s instead of assuming a missing REST value',async value=>{
 const {completeNativeRuleParameters}=await module();
 const result=await completeNativeRuleParameters({graphql:async(_query:string,variables:any)=>{expect(variables).toEqual({id:rule.node_id});return graph(value);}},rule);
 expect(result.rules[1].parameters.update_allows_fetch_and_merge).toBe(value);expect(rule.rules[1]).not.toHaveProperty('parameters');
});
it.each(['identity','database','pagination','duplicate','missing','null','string'])('rejects incomplete or mismatched native rule evidence: %s',async kind=>{
 const {completeNativeRuleParameters}=await module(),result:any=graph(false);
 if(kind==='identity')result.node.id='other';if(kind==='database')result.node.databaseId=99;
 if(kind==='pagination')result.node.rules.pageInfo.hasNextPage=true;
 if(kind==='duplicate')result.node.rules.nodes.push(result.node.rules.nodes[1]);
 if(kind==='missing')result.node.rules.nodes.pop();
 if(kind==='null')result.node.rules.nodes[1].parameters=null;
 if(kind==='string')result.node.rules.nodes[1].parameters.updateAllowsFetchAndMerge='false';
 await expect(completeNativeRuleParameters({graphql:async()=>result},rule)).rejects.toThrow('NATIVE_RULE_PARAMETERS_');
});
it('keeps native permission errors and explicit REST true values intact',async()=>{
 const {completeNativeRuleParameters}=await module();
 await expect(completeNativeRuleParameters({graphql:async()=>{throw Error('403');}},rule)).rejects.toThrow('403');
 const explicit={...rule,rules:[{type:'update',parameters:{update_allows_fetch_and_merge:true}}]};
 expect(await completeNativeRuleParameters({graphql:async()=>{throw Error('unexpected');}},explicit)).toBe(explicit);
});
