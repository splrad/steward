import { rm } from 'node:fs/promises';
import { bundleAction } from './bundle-action.mjs';

await rm(new URL('../action/dist/', import.meta.url), { force: true, recursive: true });
await bundleAction('action/dist');
