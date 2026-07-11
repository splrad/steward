import { rm } from 'node:fs/promises';
import { runProcess } from './process.mjs';

const intermediate = '.steward-build';

export async function bundleAction(output) {
  await rm('.steward-build', { force: true, recursive: true });
  try {
    await runProcess(process.execPath, [
      'node_modules/typescript/bin/tsc',
      'action/src/index.ts',
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
      `${intermediate}/action/src/index.js`,
      '--out', output,
      '--minify',
      '--source-map',
    ]);
  } finally {
    await rm('.steward-build', { force: true, recursive: true });
  }
}
