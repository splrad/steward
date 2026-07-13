import { chmod, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './process.mjs';

const intermediate = '.steward-build';

export async function bundleCli(output) {
  await rm(intermediate, { force: true, recursive: true });
  await rm(output, { force: true, recursive: true });
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
    await cp('templates/thin-workflows', path.join(output, 'templates/thin-workflows'), { recursive: true });
    await cp('templates/init', path.join(output, 'templates/init'), { recursive: true });
    await cp('templates/adoption', path.join(output, 'templates/adoption'), { recursive: true });
    await chmod(path.join(output, 'index.js'), 0o755);
  } finally {
    await rm(intermediate, { force: true, recursive: true });
  }
}
