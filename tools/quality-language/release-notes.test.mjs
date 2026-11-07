import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseNotes } from './release-notes.mjs';

function fixture({ authenticated = true, models = [{id:'native-default'}], text = '{"items":[]}', finishReason = 'stop', failure = null,
  usageModel = 'fixture', emitUsage = true, responseModel = undefined, generationEvent = null, tokenUsage = { inputTokens: 10, outputTokens: 5 },
  metrics = { currentModel: 'fixture', totalNanoAiu: 1500000000, totalPremiumRequestCost: 2, totalUserRequests: 1 }, metricsFailure = false, failureAfterUsage = null } = {}) {
  const events = [], handlers = new Map(); let clientOptions, sessionOptions;
  const client = { start: async () => events.push('start'), stop: async () => events.push('stop'),
    getAuthStatus: async () => ({ isAuthenticated: authenticated }),
    rpc: { account: { getQuota: async () => { throw Error('PERSONAL_QUOTA_NOT_APPLICABLE'); } }, models: { list: async () => ({models}) } },
    createSession: async options => {
      events.push('session'); sessionOptions = options;
      return { on: (type, handler) => handlers.set(type, handler), sendAndWait: async input => {
        events.push('send');
        if (generationEvent) handlers.get(generationEvent)?.({ data: { content: 'partial generation' } });
        if (failure) throw failure;
        if (emitUsage) handlers.get('assistant.usage')?.({ data: { model: usageModel, ...tokenUsage, finishReason } });
        if (failureAfterUsage) throw failureAfterUsage;
        return { data: { content: text, model: responseModel } };
      }, abort: async () => events.push('abort'), disconnect: async () => events.push('disconnect'),
      rpc: { usage: { getMetrics: async () => { if (metricsFailure) throw Object.assign(Error('raw secret'), { status: 403 }); return metrics; } } } };
    },
  };
  return { create: options => { clientOptions = options; return client; }, events, options: () => ({ clientOptions, sessionOptions }) };
}
test('read-only organization preflight creates no session and does not consult personal-seat quotas', async () => {
  for (const [setup, status] of [[{}, 'READY'], [{ authenticated: false }, 'WAIT_AUTH'], [{ models: [] }, 'WAIT_QUOTA']]) {
    const f = fixture(setup); assert.deepEqual(await releaseNotes('preflight', '', 'fixture-token', f.create), status === 'READY' ? { status, models: ['native-default'] } : { status });
    assert.deepEqual(f.events, ['start', 'stop']);
  }
});

test('expired tokens, organization policy and budget rejection do not retry or fall back', async () => {
  for (const status of [401,403,429]) {
    const f=fixture({failure:{status,response:{headers:new Headers({'retry-after':'120'})}}});
    assert.deepEqual(await releaseNotes('generate','{}','workflow-token',f.create),{
      status:status===429?'WAIT_QUOTA':'WAIT_AUTH',retryAfterMs:120000,
    });
    assert.deepEqual(f.events,['start','session','send','abort','disconnect','stop']);
    assert.equal(f.options().clientOptions.gitHubToken,'workflow-token');
    assert.equal(f.options().clientOptions.useLoggedInUser,false);
  }
});
test('SDK content call has no tools, agents, discovery or retained session and returns measured usage', async () => {
  const f = fixture(), result = await releaseNotes('generate', '{"prompt":"离线输入"}', 'fixture-token', f.create);
  assert.deepEqual(result, { status: 'RETURNED', text: '{"items":[]}', model: 'fixture', usage: { inputTokens: 10, outputTokens: 5,
    totalNanoAiu: 1500000000, aiCredits: 1.5, premiumRequests: 2, requests: 1, selectedModel: 'fixture' } });
  const { clientOptions: c, sessionOptions: s } = f.options();
  assert.equal(c.mode, 'empty'); assert.equal(c.useLoggedInUser, false); assert.equal(c.gitHubToken, 'fixture-token');
  assert.deepEqual(s.availableTools, []); assert.deepEqual(s.tools, []); assert.deepEqual(s.customAgents, []); assert.deepEqual(s.mcpServers, {});
  assert.equal(s.enableConfigDiscovery, false); assert.deepEqual(s.onPermissionRequest(), { kind: 'reject' }); assert.deepEqual(s.memory, { enabled: false });
  assert.deepEqual(f.events, ['start', 'session', 'send', 'disconnect', 'stop']);
});
test('SDK capacity and output limits are explicit and always stop the client', async () => {
  for (const [setup, code] of [[{ finishReason: 'length' }, 'CONTENT_CAPACITY'], [{ text: '中'.repeat(5000) }, 'CONTENT_OUTPUT_LIMIT']]) {
    const f = fixture(setup); await assert.rejects(releaseNotes('generate', '{}', 'fixture-token', f.create), new RegExp(code)); assert.equal(f.events.at(-1), 'stop');
  }
});
test('curated input above the retired byte threshold reaches the SDK and retains service capacity errors', async () => {
  const f = fixture(); const result=await releaseNotes('generate', 'x'.repeat(120 * 1024), 'fixture-token', f.create);
  assert.equal(result.status,'RETURNED');assert.deepEqual(f.events,['start','session','send','disconnect','stop']);
});

test('model evidence and optional billing units are not fabricated', async () => {
  const f = fixture({ metrics: {}, usageModel: 'event-model' });
  const result = await releaseNotes('generate', '{}', 'fixture-token', f.create);
  assert.equal(result.model, 'event-model');
  assert.equal(result.usage.aiCredits, null);
  assert.equal(result.usage.premiumRequests, null);
  const nullMetrics = fixture({ metrics: { totalNanoAiu: null } });
  assert.equal((await releaseNotes('generate', '{}', 'fixture-token', nullMetrics.create)).usage.aiCredits, null);
  const missing = fixture({ metrics: {}, emitUsage: false });
  await assert.rejects(releaseNotes('generate', '{}', 'fixture-token', missing.create), /CONTENT_MODEL_UNKNOWN/);
  const metricsOnly = fixture({ emitUsage: false, responseModel: 'response-model' });
  assert.equal((await releaseNotes('generate', '{}', 'fixture-token', metricsOnly.create)).usage.inputTokens, null);
  await assert.rejects(releaseNotes('generate', '{}', 'fixture-token', fixture({ emitUsage: false }).create), /CONTENT_MODEL_UNKNOWN/);
});

test('generation signals before a status-bearing failure never become retryable rejections', async () => {
  for (const generationEvent of ['assistant.message', 'assistant.message_start', 'assistant.message_delta', 'assistant.reasoning', 'assistant.reasoning_delta']) {
    for (const status of [401, 403, 429]) {
      const f = fixture({ generationEvent, failure: { status }, emitUsage: false });
      await assert.rejects(releaseNotes('generate', '{}', 'fixture-token', f.create), /^Error: RESPONSE_UNKNOWN$/);
      assert.deepEqual(f.events, ['start', 'session', 'send', 'abort', 'disconnect', 'stop']);
    }
  }
});

test('actual response or call model takes precedence over currently selected model', async () => {
  const metrics = { currentModel: 'selected-model' };
  const response = await releaseNotes('generate', '{}', 'fixture-token', fixture({ responseModel: 'response-model', usageModel: 'call-model', metrics }).create);
  assert.equal(response.model, 'response-model'); assert.equal(response.usage.selectedModel, 'selected-model');
  const usage = await releaseNotes('generate', '{}', 'fixture-token', fixture({ usageModel: 'call-model', metrics }).create);
  assert.equal(usage.model, 'call-model');
});

test('missing token counters remain null independently while actual zero stays zero', async () => {
  for (const [tokenUsage, expected] of [[{}, [null, null]], [{inputTokens:12}, [12,null]], [{outputTokens:0}, [null,0]], [{inputTokens:null,outputTokens:7}, [null,7]], [{inputTokens:0,outputTokens:0}, [0,0]]]) {
    const result=await releaseNotes('generate','{}','fixture-token',fixture({tokenUsage}).create);
    assert.deepEqual([result.usage.inputTokens,result.usage.outputTokens],expected);
  }
});

test('timeout and metrics failure abort, disconnect and sanitize without replaying the request', async () => {
  for (const setup of [{ failure: Error('raw token timeout') }, { metricsFailure: true }, { failureAfterUsage: { status: 429 } }]) {
    const f = fixture(setup);
    await assert.rejects(releaseNotes('generate', '{}', 'fixture-token', f.create), /^Error: RESPONSE_UNKNOWN$/);
    assert.deepEqual(f.events, ['start', 'session', 'send', 'abort', 'disconnect', 'stop']);
  }
});
