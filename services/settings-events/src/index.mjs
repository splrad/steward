import { importPKCS8, SignJWT } from 'jose';

// Fixed identities cannot be selected by incoming payloads.
export const POLICY = Object.freeze({
  app: '5639432', installation: 179184801, orgId: 302208797, org: 'splrad',
  repositoryId: 1447987054, repository: 'splrad/steward-settings', branch: 'main',
  eventType: 'settings-source-event', bot: 'splrad-governance[bot]',
});
const API = 'https://api.github.com';
const MAX_BODY = 1024 * 1024;
const ACTIONS = Object.freeze({
  repository: ['created', 'edited', 'unarchived'],
  label: ['created', 'edited', 'deleted'],
  installation: ['created', 'unsuspend', 'new_permissions_accepted'],
  installation_repositories: ['added', 'removed'],
});
const answer = (status, code) => new Response(code, {
  status, headers: {'content-type': 'text/plain', 'cache-control': 'no-store'},
});

export function eligible(event, body) {
  if (body?.installation?.id !== POLICY.installation) return false;
  const defaultBranchCreated = event === 'create' && body.ref_type === 'branch' &&
    body.ref === body.repository?.default_branch;
  if (!defaultBranchCreated && !ACTIONS[event]?.includes(body.action)) return false;
  // Suppress only writes performed by full-sync, not bot-created repositories/branches.
  if ((event === 'label' || (event === 'repository' && body.action === 'edited')) &&
    body.sender?.type === 'Bot' && body.sender?.login === POLICY.bot) return false;
  if (event.startsWith('installation')) {
    return body.installation.account?.id === POLICY.orgId &&
      body.installation.account?.login === POLICY.org &&
      body.installation.app_id === Number(POLICY.app);
  }
  return body.organization?.id === POLICY.orgId &&
    body.organization?.login === POLICY.org &&
    body.repository?.owner?.id === POLICY.orgId &&
    body.repository?.owner?.login === POLICY.org &&
    Number.isSafeInteger(body.repository?.id) && body.repository.id > 0;
}

async function boundedBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks = []; let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY) { await reader.cancel(); throw new Error('size'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}

async function verified(bytes, header, secret) {
  if (!/^sha256=[a-f0-9]{64}$/.test(header ?? '') || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
  const signature = Uint8Array.from(header.slice(7).match(/../g), x => parseInt(x, 16));
  return crypto.subtle.verify('HMAC', key, signature, bytes);
}

async function appJwt(pem) {
  const key = await importPKCS8(pem.replace(/\\n/g, '\n'), 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({}).setProtectedHeader({alg: 'RS256'}).setIssuer(POLICY.app)
    .setIssuedAt(now - 30).setExpirationTime(now + 300).sign(key);
}

// No retries: an unknown write response must be reconciled against private Actions runs.
export async function dispatch(env, metadata, fetcher = fetch, jwtFactory = appJwt) {
  let token;
  let accepted = false;
  async function call(path, method, credential, body) {
    return fetcher(API + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(1500),
      headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${credential}`,
        'user-agent': 'splrad-settings-events', 'x-github-api-version': '2026-03-10',
        'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
  }
  try {
    const jwt = await jwtFactory(env.GOVERNANCE_APP_PRIVATE_KEY);
    const mint = await call(`/app/installations/${POLICY.installation}/access_tokens`, 'POST', jwt,
      {repository_ids: [POLICY.repositoryId], permissions: {contents: 'write', metadata: 'read'}});
    if (mint.status !== 201) throw new Error('mint');
    const auth = await mint.json();
    token = auth.token;
    if (typeof token !== 'string' || !token) throw new Error('token');
    if (auth.permissions?.contents !== 'write' || auth.permissions?.metadata !== 'read' ||
      Object.entries(auth.permissions ?? {}).some(([k, v]) => !['contents', 'metadata'].includes(k) && v !== 'none'))
      throw new Error('permissions');
    const scopeResponse = await call('/installation/repositories?per_page=100', 'GET', token);
    if (scopeResponse.status !== 200) throw new Error('scope');
    const scope = await scopeResponse.json(); const repo = scope.repositories?.[0];
    if (scope.total_count !== 1 || scope.repositories?.length !== 1 ||
      repo.id !== POLICY.repositoryId || repo.full_name !== POLICY.repository ||
      repo.private !== true || repo.default_branch !== POLICY.branch) throw new Error('scope');
    const result = await call(`/repos/${POLICY.repository}/dispatches`, 'POST', token,
      {event_type: POLICY.eventType, client_payload: metadata});
    if (result.status !== 204) throw new Error('dispatch');
    accepted = true;
  } catch {
    return {accepted, code: 'dispatch_unconfirmed'};
  } finally {
    if (token) {
      try {
        const revoke = await call('/installation/token', 'DELETE', token);
        // A confirmed dispatch is not retried merely because revocation failed.
        if (revoke.status !== 204) console.warn('installation_token_revoke_unconfirmed');
      } catch { console.warn('installation_token_revoke_unconfirmed'); }
    }
  }
  return {accepted, code: 'dispatch_accepted'};
}

export async function handle(request, env, dispatchFn = dispatch) {
  const url = new URL(request.url);
  if (url.pathname !== '/github/webhook' || url.search) return answer(404, 'not_found');
  if (request.method !== 'POST') return answer(405, 'method');
  if (env.ENABLED !== 'true') return answer(503, 'disabled');
  if (!env.WEBHOOK_SECRET || !env.GOVERNANCE_APP_PRIVATE_KEY) return answer(503, 'unconfigured');
  if (!request.headers.get('content-type')?.startsWith('application/json')) return answer(415, 'content_type');
  let bytes;
  try { bytes = await boundedBody(request); } catch { return answer(413, 'body_limit'); }
  if (!await verified(bytes, request.headers.get('x-hub-signature-256'), env.WEBHOOK_SECRET)) return answer(401, 'signature');
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { return answer(400, 'json'); }
  const event = request.headers.get('x-github-event');
  const delivery = request.headers.get('x-github-delivery');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(delivery ?? '')) return answer(400, 'delivery');
  if (event === 'ping') {
    return answer(200, 'ping');
  }
  if (!eligible(event, body)) return answer(200, 'ignored');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const result = await dispatchFn(env, {delivery, event, action: body.action ?? 'default_branch_created', body_sha256: digest});
  // Never log payloads, repository names, labels, keys, tokens, URLs, or upstream bodies.
  return answer(result.accepted ? 202 : 502, result.code);
}

export default {fetch(request, env) { return handle(request, env); }};
