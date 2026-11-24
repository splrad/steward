import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {appendFile, mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// The main module, complete module set, MIME types and bytes affect what the Worker runs.
function manifest(main, modules) {
  if (typeof main !== 'string' || !modules.some(([name]) => name === main) ||
      new Set(modules.map(([name]) => name)).size !== modules.length) return null;
  modules.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return hash(JSON.stringify([main, modules]));
}

export function servingDigest(version) {
  if (!Array.isArray(version.modules)) return null;
  const entries = [];
  for (const {name, content_type: type, content_base64: base64} of version.modules) {
    if (typeof name !== 'string' || !name || typeof type !== 'string' || !type || typeof base64 !== 'string') return null;
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64) return null;
    entries.push([name, type, hash(bytes)]);
  }
  return manifest(version.main_module, entries);
}

export async function builtDigest(bundle) {
  // Wrangler --outfile writes the multipart upload body, including non-JavaScript modules.
  const firstLine = bundle.indexOf('\r\n');
  if (firstLine < 3 || firstLine > 200 || !bundle.subarray(0, 2).equals(Buffer.from('--'))) return null;
  const boundary = bundle.subarray(2, firstLine).toString();
  const form = await new Response(bundle, {headers: {'Content-Type': 'multipart/form-data; boundary=' + boundary}}).formData();
  const metadata = JSON.parse(form.get('metadata'));
  const entries = [];
  for (const [name, part] of form) {
    if (name === 'metadata') continue;
    if (!(part instanceof Blob)) return null;
    // Wrangler attaches source maps for debugging. The Workers version API lists the serving modules.
    if (part.type === 'application/source-map') continue;
    entries.push([name, part.type, hash(Buffer.from(await part.arrayBuffer()))]);
  }
  return manifest(metadata.main_module, entries);
}

async function build(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Invalid source commit');
  execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD']);
  const temp = await mkdtemp(join(tmpdir(), 'steward-worker-'));
  const target = join(temp, 'source');
  execFileSync('git', ['worktree', 'add', '--quiet', '--detach', target, sha]);
  const cwd = join(target, 'workers', 'steward');
  // The build job has no production environment or write permission. Pass only tool paths to the build.
  const bin = dirname(process.execPath);
  const npm = join(bin, '../lib/node_modules/npm/bin/npm-cli.js');
  const env = {PATH: bin + ':/usr/bin:/bin', HOME: temp, CI: 'true', WRANGLER_SEND_METRICS: 'false'};
  const options = {cwd, env, stdio: 'pipe', timeout: 180000};
  execFileSync(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], options);
  const file = join(temp, 'worker.multipart');
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outfile', file], options);
  return builtDigest(await readFile(file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const digests = {};
  for (const sha of JSON.parse(process.env.BUILD_SOURCES)) {
    try {
      const digest = await build(sha);
      if (digest) digests[sha] = digest;
    } catch {
      console.warn('Unable to reproduce Worker modules for', sha);
    }
  }
  await appendFile(process.env.GITHUB_OUTPUT, 'digests=' + JSON.stringify(digests) + '\n');
}
