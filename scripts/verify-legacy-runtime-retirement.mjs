import { pathToFileURL } from 'node:url';

/** Read-only, mandatory post-deployment gate for the isolated maintenance handover. */
export async function verifyLegacyRuntimeRetirement({ url, version, policySha, evaluatorSha }, transport = fetch) {
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Invalid runtime origin');
  if (!/^[a-f0-9-]{36}$/.test(version) || !/^[a-f0-9]{40}$/.test(policySha) || !/^[a-f0-9]{40}$/.test(evaluatorSha)) throw new Error('Missing exact deployment identity');
  const read = path => transport(new URL(path, origin), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'cache-control': 'no-cache' } });
  const health = await read('/health');
  if (health.status !== 200) throw new Error('Runtime health unavailable');
  const body = await health.json();
  if (body.status !== 'ok' || body.version !== version || body.policySha !== policySha || body.evaluatorSha !== evaluatorSha
    || body.organizationId !== 302208797 || body.appId !== 4243096 || body.secretsReady !== true) throw new Error('Runtime identity mismatch');
  // No credential/body: an enabled old route must fail authentication, never write.
  const probe = await read('/internal/releases/1187527897/v0.0.0/permit');
  if (probe.status !== 410 || probe.headers.get('cache-control') !== 'no-store') throw new Error('Legacy release retirement is not effective');
  const retired = await probe.json();
  if (retired.error !== 'LEGACY_RELEASE_RETIRED') throw new Error('Unexpected retirement response');
  // Detect a deployment changing between the identity and behavior observations.
  const after = await read('/health');
  if (after.status !== 200 || JSON.stringify(await after.json()) !== JSON.stringify(body)) throw new Error('Runtime changed during retirement verification');
  return { status: 'verified', version, policySha, evaluatorSha, releaseRoute: 410 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [url, version, policySha, evaluatorSha] = process.argv.slice(2);
  console.log(JSON.stringify(await verifyLegacyRuntimeRetirement({ url, version, policySha, evaluatorSha })));
}
