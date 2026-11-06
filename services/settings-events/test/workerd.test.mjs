import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, generateKeyPairSync} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

test('deployed bundle dispatches in workerd and never follows API redirects', async () => {
  const key = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey.export({type: 'pkcs8', format: 'pem'});
  const secret = 'ephemeral-local-runtime-test-only';
  for (const redirectAt of [null, '/app/installations/179184801/access_tokens', '/repos/splrad/steward-settings/dispatches']) {
    const calls = [];
    const mf = new Miniflare(convertV4MiniflareOptions({
      host: '127.0.0.1', modules: true,
      scriptPath: fileURLToPath(new URL('../.cloudflare/output/v0/workers/default/bundle/index.js', import.meta.url)),
      compatibilityDate: '2026-11-06',
      bindings: {ENABLED: 'true', WEBHOOK_SECRET: secret, GOVERNANCE_APP_PRIVATE_KEY: key},
      outboundService: async request => {
        const url = new URL(request.url); calls.push({origin: url.origin, path: url.pathname});
        assert.equal(url.origin, 'https://api.github.com');
        if (url.pathname === redirectAt) return new Response(null, {status: 302, headers: {location: 'https://must-not-follow.invalid/'}});
        if (url.pathname.endsWith('/access_tokens')) return Response.json({token: 'fake-test-token', permissions: {contents: 'write', metadata: 'read'}}, {status: 201});
        if (url.pathname === '/installation/repositories') return Response.json({total_count: 1, repositories: [{id: 1447987054, full_name: 'splrad/steward-settings', private: true, default_branch: 'main'}]});
        if (url.pathname.endsWith('/dispatches') || url.pathname === '/installation/token') return new Response(null, {status: 204});
        throw new Error('Unexpected outbound request');
      },
    }));
    try {
      const body = JSON.stringify({action: 'edited', installation: {id: 179184801}, organization: {id: 302208797, login: 'splrad'}, repository: {id: 123, owner: {id: 302208797, login: 'splrad'}}, sender: {type: 'User', login: 'test-user'}});
      const response = await mf.dispatchFetch('http://localhost/github/webhook', {method: 'POST', body, headers: {
        'content-type': 'application/json', 'x-github-event': 'label',
        'x-github-delivery': '12345678-1234-4321-8123-123456789012',
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
      }});
      assert.equal(response.status, redirectAt === null ? 202 : 502);
      assert.equal(calls.length, redirectAt?.endsWith('/access_tokens') ? 1 : 4);
      if (calls.length === 4) assert.equal(calls.at(-1).path, '/installation/token');
      assert.ok(calls.every(call => call.origin === 'https://api.github.com'));
    } finally { await mf.dispose(); }
  }
});
