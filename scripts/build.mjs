import { rm } from 'node:fs/promises';
import { bundleAction } from './bundle-action.mjs';
import { bundleCli } from './bundle-cli.mjs';

await rm(new URL('../action/dist/', import.meta.url), { force: true, recursive: true });
await rm(new URL('../packages/cli/dist/', import.meta.url), { force: true, recursive: true });
await bundleAction('action/dist');
await bundleCli('packages/cli/dist');
