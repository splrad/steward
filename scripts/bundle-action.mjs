import { rm } from 'node:fs/promises';
import { execa } from './process.mjs';

const intermediate = '.steward-build/action';

export async function bundleAction(output) {
  await rm('.steward-build', { force: true, recursive: true });
  try {
    await execa(process.execPath, [
      'node_modules/typescript/bin/tsc',
      'action/src/index.ts',
      '--ignoreConfig',
      '--declaration', 'false',
      '--esModuleInterop', 'true',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--noEmit', 'false',
      '--outDir', intermediate,
      '--rootDir', 'action/src',
      '--skipLibCheck', 'true',
      '--target', 'ES2024',
    ]);
    await execa(process.execPath, [
      'node_modules/@vercel/ncc/dist/ncc/cli.js',
      'build',
      `${intermediate}/index.js`,
      '--out', output,
      '--minify',
      '--source-map',
    ]);
  } finally {
    await rm('.steward-build', { force: true, recursive: true });
  }
}
