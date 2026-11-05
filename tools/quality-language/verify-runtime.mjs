import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read installed files only. Verification does not start a Copilot runtime or request authentication.
const require = createRequire(import.meta.url);
const sdkDist = dirname(fileURLToPath(import.meta.resolve('@github/copilot-sdk')));
const sdk = JSON.parse(await readFile(join(sdkDist, '..', 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(new URL('./package-lock.json', import.meta.url), 'utf8'));
const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
const platform = `${musl ? 'linuxmusl' : process.platform}-${process.arch}`;
const name = `@github/copilot-sdk-${platform}`;
const runtimeRoot = dirname(require.resolve(`${name}/package.json`));
const runtime = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'));
const runtimeVersion = (await readFile(join(sdkDist, 'cliVersion.js'), 'utf8')).match(/COPILOT_CLI_VERSION\s*=\s*"([^"]+)"/)?.[1];
if (!runtimeVersion || runtime.version !== sdk.version || lock.packages['node_modules/@github/copilot-sdk'].version !== sdk.version) {
  throw new Error('COPILOT_RUNTIME_VERSION_MISMATCH');
}
const binaries = [process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime', 'runtime.node'];
for (const file of binaries) {
  const info = await stat(join(runtimeRoot, 'prebuilds', platform, file));
  if (!info.isFile() || info.size === 0) throw new Error('COPILOT_RUNTIME_MISSING');
}
console.log(JSON.stringify({ sdk: sdk.version, runtime: runtimeVersion, platform, installed: true, modelCalls: 0 }));
