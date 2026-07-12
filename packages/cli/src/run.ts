#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { main } from './main.js';

const executable = process.argv[1];
if (!executable) throw new Error('Steward CLI executable path is unavailable');
const executableDirectory = path.dirname(realpathSync(executable));
process.exitCode = await main(process.argv.slice(2), process.env, {
  templateDirectory: path.join(executableDirectory, 'templates'),
});
