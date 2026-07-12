import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [scenario, operation, ...args] = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) throw new Error(`Missing ${name}`);
  return args[index + 1];
};
const context = JSON.parse(await readFile(option('--context'), 'utf8'));
if (context.contractVersion !== 1) throw new Error('Unexpected contract version');

if (operation === 'plan') {
  await writeFile(option('--output'), JSON.stringify({
    contractVersion: 1,
    displayVersion: '1.2.3',
    buildId: `1.2.3+${context.pullRequest.mergeSha.slice(0, 7)}`,
    tagName: 'v1.2.3',
    releaseTitle: 'Fixture v1.2.3',
  }));
} else if (operation === 'build') {
  const outputDirectory = option('--output-dir');
  await mkdir(path.join(outputDirectory, 'nested'));
  const contents = Buffer.from('fixture release asset\n');
  await writeFile(path.join(outputDirectory, 'nested', 'fixture.zip'), contents);
  const assetPath = scenario === 'unsafe-path' ? '../fixture.zip' : 'nested/fixture.zip';
  await writeFile(option('--manifest'), JSON.stringify({
    contractVersion: 1,
    assets: [{
      path: assetPath,
      name: 'fixture.zip',
      mediaType: 'application/zip',
      size: contents.length,
      sha256: createHash('sha256').update(contents).digest('hex'),
    }],
  }));
} else {
  throw new Error(`Unsupported operation: ${operation}`);
}

