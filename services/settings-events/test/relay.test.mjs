import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, exportPKCS8, jwtVerify} from 'jose';
import worker, {handle, eligible, dispatch, POLICY} from '../src/index.mjs';
import {generateKeyPairSync, createPrivateKey} from 'node:crypto';
import {toPKCS8} from '../tools/key-format.mjs';

const env = {ENABLED: 'true', WEBHOOK_SECRET: 'unit-test-only-not-a-production-secret', GOVERNANCE_APP_PRIVATE_KEY: 'test-placeholder'};
const delivery = '12345678-1234-4321-8123-123456789012';
const payload = () => ({action: 'edited', installation: {id: POLICY.installation},
  organization: {id: POLICY.orgId, login: POLICY.org},
  repository: {id: 123, owner: {id: POLICY.orgId, login: POLICY.org}},
  sender: {type: 'User', login: 'test-user'}, label: {name: 'private-label', description: 'private-text'}});
async function request(body = payload(), event = 'label', options = {}, secret = env.WEBHOOK_SECRET) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes)), x => x.toString(16).padStart(2, '0')).join('');
  return new Request('https://unit.test/github/webhook', {method: 'POST', body: bytes, headers: {
    'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}`,
    'x-github-event': event, 'x-github-delivery': delivery, ...options,
  }});
}
test('valid signed source dispatches only non-private correlation metadata', async () => {
  let captured;
  const r = await handle(await request(), env, async (_, m) => {captured = m; return {accepted: true, code: 'dispatch_accepted'};});
  assert.equal(r.status, 202); assert.deepEqual(Object.keys(captured).sort(), ['action', 'body_sha256', 'delivery', 'event']);
  assert.equal(captured.delivery, delivery); assert.match(captured.body_sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(captured).includes('private'));
});
test('tampered signature, wrong installation/org and own bot cannot dispatch', async () => {
  let calls = 0; const spy = async () => {calls++; return {accepted: true};};
  assert.equal((await handle(await request(payload(), 'label', {'x-hub-signature-256': 'sha256='+'0'.repeat(64)}), env, spy)).status, 401);
  for (const edit of [b => b.installation.id++, b => b.organization.id++, b => b.repository.owner.id++, b => b.sender = {type: 'Bot', login: POLICY.bot}]) {
    const b = payload(); edit(b); assert.equal((await handle(await request(b), env, spy)).status, 200);
  }
  assert.equal(calls, 0);
});
test('explicit lifecycle whitelist; configuration push is not doubled', () => {
  for (const event of ['repository', 'label']) {
    const b = payload(); b.action = 'created'; assert.equal(eligible(event, b), true);
  }
  const b = payload(); b.sender = {type: 'Bot', login: 'another-bot[bot]'}; assert.equal(eligible('label', b), true);
  for (const event of ['push', 'workflow_dispatch', 'repository_dispatch', 'issues']) assert.equal(eligible(event, b), false);
  b.action = 'archived'; assert.equal(eligible('label', b), false);
  const install = {action: 'added', installation: {id: POLICY.installation, app_id: Number(POLICY.app), account: {id: POLICY.orgId, login: POLICY.org}}};
  assert.equal(eligible('installation_repositories', install), true);
  install.installation.app_id++; assert.equal(eligible('installation_repositories', install), false);
});
test('disabled default worker and oversize request fail closed', async () => {
  assert.equal((await worker.fetch(await request(), {...env, ENABLED: 'false'}, {})).status, 503);
  const huge = new Request('https://unit.test/github/webhook', {method:'POST', headers:{'content-type':'application/json'}, body:'x'.repeat(1024*1024+1)});
  assert.equal((await handle(huge, env)).status, 413);
});
test('empty-repository bootstrap default branch is accepted even from governance bot', () => {
  const b = payload(); b.sender = {type:'Bot',login:POLICY.bot}; b.action = 'created';
  assert.equal(eligible('repository',b),true);
  delete b.action; b.ref_type='branch'; b.ref='main'; b.repository.default_branch='main';
  assert.equal(eligible('create',b),true);
  b.ref='unrelated'; assert.equal(eligible('create',b),false);
});

const scope = {total_count: 1, repositories: [{id: POLICY.repositoryId, full_name: POLICY.repository, private: true, default_branch: 'main'}]};
function transport({badScope = false, dispatchThrows = false, revokeFails = false, broadPermission = false, metadata = 'read'} = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({url, ...init});
    if (url.endsWith('/access_tokens')) return Response.json({token: 'fake-test-token', permissions: {contents: 'write', ...(metadata === null ? {} : {metadata}), ...(broadPermission ? {administration:'write'} : {})}}, {status: 201});
    if (url.includes('/installation/repositories')) return Response.json(badScope ? {...scope, total_count:2} : scope);
    if (url.endsWith('/dispatches')) {if (dispatchThrows) throw new Error('unknown write response'); return new Response(null, {status:204});}
    if (url.endsWith('/installation/token')) return new Response(null,{status:revokeFails ? 500 : 204});
    throw new Error('unexpected API');
  };
  return {calls, fetcher};
}
test('real ephemeral RSA signing; fixed minimal token, private destination and revocation', async () => {
  const {privateKey, publicKey} = await generateKeyPair('RS256', {extractable:true});
  const key = await exportPKCS8(privateKey); const t = transport();
  const r = await dispatch({...env, GOVERNANCE_APP_PRIVATE_KEY:key}, {delivery}, t.fetcher);
  assert.equal(r.accepted, true); assert.equal(t.calls.length, 4);
  const jwt = t.calls[0].headers.authorization.slice(7);
  const verified = await jwtVerify(jwt, publicKey, {issuer:POLICY.app, algorithms:['RS256']}); assert.ok(verified.payload.exp);
  assert.deepEqual(JSON.parse(t.calls[0].body), {repository_ids:[POLICY.repositoryId], permissions:{contents:'write',metadata:'read'}});
  assert.equal(t.calls[2].url, 'https://api.github.com/repos/splrad/steward-settings/dispatches');
  assert.equal(t.calls[3].method, 'DELETE'); assert.equal(t.calls[2].redirect, 'manual');
});
test('scope and permissions mismatches prevent dispatch and still revoke', async () => {
  for (const options of [{badScope:true},{broadPermission:true},{metadata:'write'},{metadata:null}]) {
    const t = transport(options); const r = await dispatch(env, {}, t.fetcher, async () => 'fake-jwt');
    assert.equal(r.accepted, false); assert.equal(t.calls.filter(c => c.url.endsWith('/dispatches')).length, 0);
    assert.equal(t.calls.at(-1).method, 'DELETE');
  }
});
test('unknown dispatch response performs no blind retry and revokes token', async () => {
  const t = transport({dispatchThrows:true}); const r = await dispatch(env, {}, t.fetcher, async () => 'fake-jwt');
  assert.equal(r.accepted, false); assert.equal(r.code, 'dispatch_unconfirmed');
  assert.equal(t.calls.filter(c => c.url.endsWith('/dispatches')).length, 1); assert.equal(t.calls.at(-1).method, 'DELETE');
});
test('confirmed dispatch remains accepted if revoke fails', async () => {
  const t = transport({revokeFails:true}); const r = await dispatch(env, {}, t.fetcher, async () => 'fake-jwt');
  assert.equal(r.accepted, true); assert.equal(t.calls.filter(c => c.url.endsWith('/dispatches')).length, 1);
});
test('duplicate delivery is safe at-least-once wakeup, not an exactly-once guarantee', async () => {
  let calls=0; const spy=async () => {calls++;return {accepted:true,code:'dispatch_accepted'};};
  for(let i=0;i<2;i++) assert.equal((await handle(await request(),env,spy)).status,202);
  assert.equal(calls,2);
});
test('offline PKCS1 conversion retains key identity without production material', () => {
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const pkcs1=privateKey.export({type:'pkcs1',format:'pem'});
  const pkcs8=toPKCS8(pkcs1); assert.ok(pkcs8.startsWith('-----BEGIN PRIVATE KEY-----'));
  assert.deepEqual(createPrivateKey(pkcs8).export({format:'jwk'}),privateKey.export({format:'jwk'}));
});

test('warm signing reuses only the CryptoKey; rotation and failed imports cannot reuse old credentials', async t => {
  const first = await generateKeyPair('RS256', {extractable:true});
  const second = await generateKeyPair('RS256', {extractable:true});
  const pem1 = await exportPKCS8(first.privateKey), pem2 = await exportPKCS8(second.privateKey);
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  let imports = 0;
  t.mock.method(crypto.subtle, 'importKey', async (...args) => {
    if (args[0] === 'pkcs8') imports++;
    return original(...args);
  });
  for (const [pem, publicKey, expectedImports] of [[pem1,first.publicKey,1],[pem1,first.publicKey,1],[pem2,second.publicKey,2]]) {
    const transportResult = transport();
    assert.equal((await dispatch({...env,GOVERNANCE_APP_PRIVATE_KEY:pem},{delivery},transportResult.fetcher)).accepted,true);
    assert.equal(imports,expectedImports);
    assert.equal(transportResult.calls.length,4);
    assert.equal(transportResult.calls.at(-1).method,'DELETE');
    const jwt=transportResult.calls[0].headers.authorization.slice(7);
    const verified=await jwtVerify(jwt,publicKey,{issuer:POLICY.app,algorithms:['RS256']});
    assert.equal(verified.payload.exp-verified.payload.iat,330);
  }
  for(let i=0;i<2;i++) {
    const transportResult=transport();
    assert.equal((await dispatch({...env,GOVERNANCE_APP_PRIVATE_KEY:'invalid'},{delivery},transportResult.fetcher)).accepted,false);
    assert.equal(transportResult.calls.length,0);
  }
});

test('webhook key reuse verifies every body and immediately honors secret rotation', async t => {
  const secret1='ephemeral-rotation-first',secret2='ephemeral-rotation-second';
  const original=crypto.subtle.importKey.bind(crypto.subtle);let imports=0;
  t.mock.method(crypto.subtle,'importKey',async (...args)=>{
    if(args[0]==='raw' && args[4]?.includes('verify'))imports++;
    return original(...args);
  });
  const spy=async()=>({accepted:true});
  for(const [binding,signature,status,count] of [[secret1,secret1,202,1],[secret1,secret1,202,1],[secret2,secret1,401,2],[secret2,secret2,202,2]]){
    const result=await handle(await request(payload(),'label',{},signature),{...env,WEBHOOK_SECRET:binding},spy);
    assert.equal(result.status,status);assert.equal(imports,count);
  }
});
