import { chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './process.mjs';

const intermediate = '.steward-build';

export async function bundleCli(output) {
  await rm(intermediate, { force: true, recursive: true });
  try {
    await runProcess(process.execPath, [
      'node_modules/typescript/bin/tsc',
      'packages/cli/src/run.ts',
      '--ignoreConfig',
      '--declaration', 'false',
      '--esModuleInterop', 'true',
      '--module', 'ESNext',
      '--moduleResolution', 'Bundler',
      '--noEmit', 'false',
      '--outDir', intermediate,
      '--rootDir', '.',
      '--skipLibCheck', 'true',
      '--target', 'ES2024',
      '--types', 'node',
    ]);
    await runProcess(process.execPath, [
      'node_modules/@vercel/ncc/dist/ncc/cli.js',
      'build',
      `${intermediate}/packages/cli/src/run.js`,
      '--out', output,
      '--minify',
      '--source-map',
    ]);
    await chmod(path.join(output, 'index.js'), 0o755);
  } finally {
    await rm(intermediate, { force: true, recursive: true });
  }
}

