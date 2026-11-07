import assert from 'node:assert/strict';
import test from 'node:test';
import { access } from 'node:fs/promises';
import { qualityLanguage } from './run.mjs';
const item={sourceCommentId:'review:1',sourceCommit:'a'.repeat(40),sourceUrl:'https://github.com/a/b/pull/1',severity:'P1',originalIdentifiers:['API'],segmentIndex:0,
  problemZh:'存在问题。',impactZh:'调用失败。',suggestionZh:'验证输入。'};
function fixture({auth=true,models=[{id:'native-default'}],reply={items:[item]},failure=null,metricsFailure=false,totalNanoAiu=1500000000,
  responseModel=undefined,currentModel='actual-model'}={}) {
  const events=[],handlers=new Map();let clientOptions,sessionOptions,sendArgs;
  const client={start:async()=>events.push('start'),stop:async()=>events.push('stop'),getAuthStatus:async()=>({isAuthenticated:auth}),
    rpc:{account:{getQuota:async()=>{throw Error('PERSONAL_QUOTA_NOT_APPLICABLE');}},models:{list:async()=>({models})}},
    createSession:async options=>{sessionOptions=options;events.push('session');return {on:(key,fn)=>handlers.set(key,fn),abort:async()=>events.push('abort'),disconnect:async()=>events.push('disconnect'),
      sendAndWait:async(...args)=>{sendArgs=args;events.push('send');if(failure)throw failure;handlers.get('assistant.usage')({data:{model:'actual-model',inputTokens:11,outputTokens:7}});return {data:{content:JSON.stringify(reply),model:responseModel}};},
      rpc:{usage:{getMetrics:async()=>{if(metricsFailure)throw Error('raw session secret');return {currentModel,totalNanoAiu,totalPremiumRequestCost:2,totalUserRequests:1};}}}};}};
  return {create:options=>{clientOptions=options;return client;},events,options:()=>({clientOptions,sessionOptions,sendArgs})};
}
test('organization-token preflight checks auth and available models without consulting personal quotas',async()=>{
  for(const [options,status] of [[{},'READY'],[{auth:false},'WAIT_AUTH'],[{models:[]},'WAIT_QUOTA']]) {
    const f=fixture(options),result=await qualityLanguage('preflight','','fixture',f.create);assert.equal(result.status,status);assert.deepEqual(f.events,['start','stop']);
    await assert.rejects(access(f.options().clientOptions.baseDirectory));
  }
});
test('the installed SDK gets the exact supported schema call and isolated session; records both billing units separately',async()=>{
  const f=fixture(),result=await qualityLanguage('translate','{"items":[{}]}','fixture',f.create);
  assert.equal(result.status,'RETURNED');assert.equal(result.model,'actual-model');assert.equal(result.usage.aiCredits,1.5);assert.equal(result.usage.premiumRequests,2);
  const {clientOptions:c,sessionOptions:s,sendArgs:args}=f.options();
  assert.equal(c.mode,'empty');assert.equal(c.gitHubToken,'fixture');assert.equal(c.useLoggedInUser,false);assert.deepEqual(c.builtinPluginDirectories,[]);
  assert.equal(c.logLevel,'none');assert.equal(s.model,undefined);assert.deepEqual(s.availableTools,[]);assert.deepEqual(s.tools,[]);assert.deepEqual(s.mcpServers,{});
  assert.deepEqual(s.customAgents,[]);assert.deepEqual(s.instructionDirectories,[]);assert.equal(s.enableConfigDiscovery,false);assert.deepEqual(s.onPermissionRequest(),{kind:'reject'});
  assert.deepEqual(s.infiniteSessions,{enabled:false});assert.deepEqual(s.memory,{enabled:false});assert.equal(s.systemMessage.mode,'append');
  assert.equal(args[0].prompt,'{"items":[{}]}');assert.equal(args[0].responseSchema.additionalProperties,false);assert.equal(args[1],120000);
  assert.deepEqual(f.events,['start','session','send','disconnect','stop']);await assert.rejects(access(c.baseDirectory));
});
test('malformed/model-injected output, timeout and metrics failure abort and sanitize errors',async()=>{
  for(const options of [{reply:{...item,tool:'exec'}},{failure:Error('secret token inside raw failure')},{metricsFailure:true}]) {
    const f=fixture(options);await assert.rejects(qualityLanguage('translate','{"items":[{}]}','fixture',f.create),/^(Error: )?(QUALITY_OUTPUT_SCHEMA|RESPONSE_UNKNOWN)$/);
    assert.deepEqual(f.events.slice(-3),['abort','disconnect','stop']);
  }
});
test('runtime auth/quota errors preserve Retry-After and close resources',async()=>{
  for (const status of [401,403,429]) {
    const f=fixture({failure:{status,response:{headers:new Headers({'retry-after':'600'})}}});
    const result=await qualityLanguage('translate','{"items":[{}]}','fixture',f.create);
    assert.deepEqual(result,{status:status===429?'WAIT_QUOTA':'WAIT_AUTH',retryAfterMs:600000});
    assert.equal(f.events.filter(event=>event==='send').length,1);
    assert.deepEqual(f.events.slice(-3),['abort','disconnect','stop']);
  }
});
test('oversized input or unknown mode never constructs a client',async()=>{
  const f=fixture();await assert.rejects(qualityLanguage('translate','x'.repeat(24577),'fixture',f.create),/INPUT_LIMIT/);
  await assert.rejects(qualityLanguage('other','','fixture',f.create),/INPUT_LIMIT/);assert.deepEqual(f.events,[]);
});

test('null metering is preserved as unknown rather than zero credits', async () => {
  const f=fixture({totalNanoAiu:null});
  const result=await qualityLanguage('translate','{"items":[{}]}','fixture',f.create);
  assert.equal(result.usage.totalNanoAiu,null);assert.equal(result.usage.aiCredits,null);
});

test('quality records the response or call model rather than a selected-model snapshot', async () => {
  const f=fixture({responseModel:'response-model',currentModel:'selected-model'});
  assert.equal((await qualityLanguage('translate','{"items":[{}]}','fixture',f.create)).model,'response-model');
  const fallback=fixture({currentModel:'selected-model'});
  assert.equal((await qualityLanguage('translate','{"items":[{}]}','fixture',fallback.create)).model,'actual-model');
});
