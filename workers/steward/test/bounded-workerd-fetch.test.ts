import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Use the same workerd and bundler versions as the repository's pinned Wrangler.
const requireWrangler = createRequire(import.meta.resolve('wrangler'));
const { Miniflare, convertV4MiniflareOptions } = requireWrangler('miniflare');
const { build } = requireWrangler('esbuild');

async function startWorker(contents: string, outboundService: (request: Request) => Promise<Response>) {
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL('../src/', import.meta.url)), contents },
    bundle: true, write: false, format: 'esm', platform: 'node',
  });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-08-16', compatibilityFlags: ['nodejs_compat'],
    bindings: {
      APP_ID: '1', INSTALLATION_ID: '1',
      STEWARD_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    },
    outboundService,
  }));
}

const mint = '/app/installations/1/access_tokens';

it('reads the target and dispatches the fixed workflow using the native Worker fetch', async () => {
  const pin = 'a'.repeat(40);
  const workflow = 'release-candidate-event.yml';
  const calls: string[] = [];
  const targetRef = '/repos/splrad/LayerScape/git/ref/heads/main';
  const centralRef = '/repos/splrad/steward/git/ref/heads/main';
  const workflowPath = '/repos/splrad/steward/actions/workflows/' + workflow;
  const runtime = await startWorker(`
    import { BoundedGitHub, TARGET, CENTRAL } from './bounded-recheck-github.ts';
    import { dispatchFixed } from './bounded-recheck-effects.ts';
    export default { async fetch(_request, env) {
      const reader = new BoundedGitHub(env);
      const ref = await reader.json(TARGET.id, '/repos/' + TARGET.name + '/git/ref/heads/main');
      await dispatchFixed(reader, CENTRAL.id, '${workflow}', ref.object.sha, {});
      return new Response(null, {status: 204});
    }};
  `, async request => {
    const url = new URL(request.url);
    calls.push(request.method + ' ' + url.pathname);
    if (url.origin !== 'https://api.github.com') return new Response(null, { status: 403 });
    if (url.pathname === mint) return Response.json({ token: 'fixture-only' });
    if (url.pathname === centralRef || url.pathname === targetRef) return Response.json({ object: { sha: pin } });
    if (url.pathname === workflowPath) return Response.json({ state: 'active', path: '.github/workflows/' + workflow });
    if (url.pathname === workflowPath + '/dispatches') return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  });
  try {
    const result = await runtime.dispatchFetch('http://fixture.local/');
    expect(result.status).toBe(204);
    expect(calls).toEqual([
      'POST ' + mint, 'GET ' + targetRef, 'POST ' + mint, 'GET ' + workflowPath,
      'GET ' + centralRef, 'POST ' + mint, 'POST ' + workflowPath + '/dispatches',
    ]);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

it.each([200, 302, 'untrusted origin'])('validates the artifact download target and response (%s)', async signedStatus => {
  // Stored ZIP with one member, value.json, containing {"ok":true}.
  const zip = Buffer.from('UEsDBBQAAAAAAAAAIQCQX9SnCwAAAAsAAAAKAAAAdmFsdWUuanNvbnsib2siOnRydWV9UEsBAhQAFAAAAAAAAAAhAJBf1KcLAAAACwAAAAoAAAAAAAAAAAAAAIABAAAAAHZhbHVlLmpzb25QSwUGAAAAAAEAAQA4AAAAMwAAAAAA', 'base64');
  const artifact = {
    id: 2, name: 'result', expired: false, workflow_run: { id: 1 },
    digest: 'sha256:' + createHash('sha256').update(zip).digest('hex'), size_in_bytes: zip.length,
  };
  const api = 'https://api.github.com';
  const actions = api + '/repos/splrad/LayerScape/actions';
  const list = actions + '/runs/1/artifacts?per_page=100';
  const detail = actions + '/artifacts/2';
  const signedUrl = signedStatus === 'untrusted origin' ? 'https://signed.invalid/object' : 'https://fixture.blob.core.windows.net/object';
  const calls: { url: string; authenticated: boolean }[] = [];
  const runtime = await startWorker(`
    import { BoundedGitHub, TARGET } from './bounded-recheck-github.ts';
    export default { async fetch(_request, env) {
      try {
        const artifact = await new BoundedGitHub(env).artifact(TARGET.id, 1, 'result', 'value.json');
        return Response.json(artifact.value);
      } catch (error) {
        return new Response(error.message, {status: 502});
      }
    }};
  `, async request => {
    calls.push({ url: request.url, authenticated: request.headers.has('authorization') });
    if (request.url === api + mint) return Response.json({ token: 'fixture-only' });
    if (request.url === list) return Response.json({ total_count: 1, artifacts: [artifact] });
    if (request.url === detail + '/zip') return Response.redirect(signedUrl, 302);
    if (request.url === signedUrl) {
      return signedStatus === 200 ? new Response(zip) : Response.redirect('https://unexpected.invalid/', 302);
    }
    if (request.url === detail) return Response.json(artifact);
    return new Response(null, { status: 404 });
  });
  try {
    const response = await runtime.dispatchFetch('http://fixture.local/');
    if (signedStatus === 200) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } else {
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(signedStatus === 'untrusted origin' ? 'ARTIFACT_ORIGIN' : 'HTTP_READ_FAILED');
    }
    const expected = [api + mint, list, detail + '/zip'];
    if (signedStatus !== 'untrusted origin') expected.push(signedUrl);
    if (signedStatus === 200) expected.push(detail);
    expect(calls).toEqual(expected.map(url => ({ url, authenticated: url !== signedUrl })));
  } finally {
    await runtime.dispose();
  }
}, 30_000);
