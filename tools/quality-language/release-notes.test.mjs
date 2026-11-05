import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseNotes } from './release-notes.mjs';

function fixture({ authenticated = true, models = [{id:'native-default'}], text = '{"items":[]}', finishReason = 'stop', failure = null } = {}) {
  const events = [], handlers = new Map(); let clientOptions, sessionOptions;
  const client = { start: async () => events.push('start'), stop: async () => events.push('stop'),
    getAuthStatus: async () => ({ isAuthenticated: authenticated }),
    rpc: { account: { getQuota: async () => { throw Error('PERSONAL_QUOTA_NOT_APPLICABLE'); } }, models: { list: async () => ({models}) } },
    createSession: async options => {
      events.push('session'); sessionOptions = options;
      return { on: (type, handler) => handlers.set(type, handler), sendAndWait: async input => {
        events.push('send'); if (failure) throw failure;
        handlers.get('assistant.usage')?.({ data: { model: 'fixture', inputTokens: 10, outputTokens: 5, finishReason } });
        return { data: { content: text } };
      } };
    },
  };
  return { create: options => { clientOptions = options; return client; }, events, options: () => ({ clientOptions, sessionOptions }) };
}
test('read-only organization preflight creates no session and does not consult personal-seat quotas', async () => {
  for (const [setup, status] of [[{}, 'READY'], [{ authenticated: false }, 'WAIT_AUTH'], [{ models: [] }, 'WAIT_QUOTA']]) {
    const f = fixture(setup); assert.deepEqual(await releaseNotes('preflight', '', 'fixture-token', f.create), { status });
    assert.deepEqual(f.events, ['start', 'stop']);
  }
});

test('expired tokens, organization policy and budget rejection do not retry or fall back', async () => {
  for (const status of [401,403,429]) {
    const f=fixture({failure:{status,response:{headers:new Headers({'retry-after':'120'})}}});
    assert.deepEqual(await releaseNotes('generate','{}','workflow-token',f.create),{
      status:status===429?'WAIT_QUOTA':'WAIT_AUTH',retryAfterMs:120000,
    });
    assert.deepEqual(f.events,['start','session','send','stop']);
    assert.equal(f.options().clientOptions.gitHubToken,'workflow-token');
    assert.equal(f.options().clientOptions.useLoggedInUser,false);
  }
});
test('SDK content call has no tools, agents, discovery or retained session and returns measured usage', async () => {
  const f = fixture(), result = await releaseNotes('generate', '{"prompt":"离线输入"}', 'fixture-token', f.create);
  assert.deepEqual(result, { status: 'RETURNED', text: '{"items":[]}', model: 'fixture', usage: { inputTokens: 10, outputTokens: 5 } });
  const { clientOptions: c, sessionOptions: s } = f.options();
  assert.equal(c.mode, 'empty'); assert.equal(c.useLoggedInUser, false); assert.equal(c.gitHubToken, 'fixture-token');
  assert.deepEqual(s.availableTools, []); assert.deepEqual(s.tools, []); assert.deepEqual(s.customAgents, []); assert.deepEqual(s.mcpServers, {});
  assert.equal(s.enableConfigDiscovery, false); assert.deepEqual(s.onPermissionRequest(), { kind: 'reject' }); assert.deepEqual(s.memory, { enabled: false });
  assert.deepEqual(f.events, ['start', 'session', 'send', 'stop']);
});
test('SDK capacity and output limits are explicit and always stop the client', async () => {
  for (const [setup, code] of [[{ finishReason: 'length' }, 'CONTENT_CAPACITY'], [{ text: '中'.repeat(5000) }, 'CONTENT_OUTPUT_LIMIT']]) {
    const f = fixture(setup); await assert.rejects(releaseNotes('generate', '{}', 'fixture-token', f.create), new RegExp(code)); assert.equal(f.events.at(-1), 'stop');
  }
});
test('curated input above the retired byte threshold reaches the SDK and retains service capacity errors', async () => {
  const f = fixture(); const result=await releaseNotes('generate', 'x'.repeat(120 * 1024), 'fixture-token', f.create);
  assert.equal(result.status,'RETURNED');assert.deepEqual(f.events,['start','session','send','stop']);
});
