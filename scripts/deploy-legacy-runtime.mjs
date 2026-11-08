import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { verifyLegacyRuntimeRetirement } from './verify-legacy-runtime-retirement.mjs';

const execute = promisify(execFile);
const policySha = 'e990eda24ef7099264dada118b3e7ddfad883cea';
const evaluatorSha = '2b1f04796de0231e74d40351dc0f4c8b07afe77d';

/** This verifies only the new-request barrier; inflight reconciliation remains separate. */
export async function runDeploymentTransaction(deploy, verify) {
  const identity = await deploy();
  const evidence = await verify(identity);
  if (evidence?.status !== 'verified' || evidence.version !== identity.version) throw new Error('Retirement probe did not verify the deployed version');
  return { status: 'barrier-installed-and-probed', ...identity };
}

export async function deployLegacyRuntime({ expectedHead, expectedBundleSha256, runtimeUrl, accountId }) {
  if (!/^[a-f0-9]{40}$/.test(expectedHead) || !/^[a-f0-9]{64}$/.test(expectedBundleSha256) || !/^[a-f0-9]{32}$/.test(accountId)) throw new Error('Exact reviewed head, bundle digest and account are required');
  const url = new URL(runtimeUrl);
  if (url.protocol !== 'https:' || !url.hostname.startsWith('splrad-steward-runtime.') || !url.hostname.endsWith('.workers.dev')
    || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw new Error('Unexpected Worker origin');
  const nodeVersion = (await readFile('.node-version', 'utf8')).trim();
  if (process.version !== `v${nodeVersion}`) throw new Error('Use the reviewed source toolchain');
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const installed = JSON.parse(await readFile('node_modules/wrangler/package.json', 'utf8'));
  if (installed.version !== lock.packages['node_modules/wrangler']?.version) throw new Error('Wrangler differs from the reviewed lock');
  const run = async (command, args, options = {}) => execute(command, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options });
  const assertSource = async () => {
    if ((await run('git', ['rev-parse', 'HEAD'])).stdout.trim() !== expectedHead
      || (await run('git', ['status', '--porcelain', '--untracked-files=all'])).stdout.trim()) throw new Error('Deployment checkout is not the exact clean reviewed head');
  };
  await assertSource();
  for (const directory of ['.', 'packages/runtime']) {
    if ((await readdir(directory)).some(name => /^\.(?:env|dev\.vars)(?:\.|$)/.test(name))) throw new Error('Local environment files are not permitted in the deployment checkout');
  }
  const commit = JSON.parse((await run('gh', ['api', `repos/splrad/steward/commits/${expectedHead}`])).stdout);
  if (commit.sha !== expectedHead || commit.commit?.verification?.verified !== true || commit.commit.verification.reason !== 'valid') throw new Error('Reviewed head signature is not verified');
  const output = await mkdtemp(join(tmpdir(), 'legacy-runtime-reviewed-'));
  const cli = resolve('node_modules/wrangler/bin/wrangler.js');
  const config = ['--config', 'packages/runtime/wrangler.toml', '--name', 'splrad-steward-runtime'];
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' };
  await run(process.execPath, [cli, 'deploy', '--dry-run', ...config, '--outdir', output], { env });
  const bundle = join(output, 'index.js');
  if (createHash('sha256').update(await readFile(bundle)).digest('hex') !== expectedBundleSha256) throw new Error('Rebuilt Worker differs from the reviewed digest');
  await assertSource();
  // No D1 migrations command and no invocation of the historical deployment workflow.
  return runDeploymentTransaction(async () => {
    const result = await run(process.execPath, [cli, 'deploy', bundle, '--no-bundle', ...config, '--keep-vars',
      '--var', 'LEGACY_RELEASE_RETIRED:true', '--var', `POLICY_SHA:${policySha}`, '--var', `WORKFLOW_EVALUATOR_SHA:${evaluatorSha}`], { env });
    const versions = [...result.stdout.matchAll(/Current Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/g)];
    if (versions.length !== 1) throw new Error('Deployment returned no unambiguous version; reconcile before retrying');
    return { version: versions[0][1], policySha, evaluatorSha, head: expectedHead, bundleSha256: expectedBundleSha256 };
  }, identity => verifyLegacyRuntimeRetirement({ url: runtimeUrl, ...identity }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [expectedHead, expectedBundleSha256, runtimeUrl, accountId] = process.argv.slice(2);
  console.log(JSON.stringify(await deployLegacyRuntime({ expectedHead, expectedBundleSha256, runtimeUrl, accountId })));
}
