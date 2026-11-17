import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Use the same workerd and bundler versions as the repository's pinned Wrangler.
const requireWrangler = createRequire(import.meta.resolve('wrangler'));
const { Miniflare, convertV4MiniflareOptions } = requireWrangler('miniflare');
const { build } = requireWrangler('esbuild');

it('reads the target and dispatches the fixed workflow using the native Worker fetch', async () => {
  const pin = 'a'.repeat(40);
  const workflow = 'release-candidate-event.yml';
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
      contents: `
        import { BoundedGitHub, TARGET, CENTRAL } from './bounded-recheck-github.ts';
        import { dispatchFixed } from './bounded-recheck-effects.ts';
        export default { async fetch(_request, env) {
          const reader = new BoundedGitHub(env);
          const ref = await reader.json(TARGET.id, '/repos/' + TARGET.name + '/git/ref/heads/main');
          await dispatchFixed(reader, CENTRAL.id, '${workflow}', ref.object.sha, {});
          return new Response(null, {status: 204});
        }};
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'node',
  });
  const calls: string[] = [];
  const mint = '/app/installations/1/access_tokens';
  const targetRef = '/repos/splrad/LayerScape/git/ref/heads/main';
  const centralRef = '/repos/splrad/steward/git/ref/heads/main';
  const workflowPath = '/repos/splrad/steward/actions/workflows/' + workflow;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-08-16', compatibilityFlags: ['nodejs_compat'],
    bindings: {
      APP_ID: '1', INSTALLATION_ID: '1',
      STEWARD_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    },
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      calls.push(request.method + ' ' + url.pathname);
      if (url.origin !== 'https://api.github.com') return new Response(null, { status: 403 });
      if (url.pathname === mint) return Response.json({ token: 'fixture-only' });
      if (url.pathname === centralRef || url.pathname === targetRef) return Response.json({ object: { sha: pin } });
      if (url.pathname === workflowPath) return Response.json({ state: 'active', path: '.github/workflows/' + workflow });
      if (url.pathname === workflowPath + '/dispatches') return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    },
  }));
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
