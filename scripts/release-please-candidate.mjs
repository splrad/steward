import { GitHub } from 'release-please/build/src/github.js';
import { generateCandidate } from '../packages/runner/dist/index.js';

// A separate process receives only the repository read token and frozen generation facts.
const token = process.env.STEWARD_CANDIDATE_READ_TOKEN ?? '';
delete process.env.STEWARD_CANDIDATE_READ_TOKEN;
for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {};
try {
  if (!token || /[\r\n\0]/.test(token)) throw new Error('CANDIDATE_READ_CREDENTIAL_REQUIRED');
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw new Error('CANDIDATE_INPUT_LIMIT'); }
  const request = JSON.parse(input), [owner, repo] = request.repository.split('/');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository)) throw new Error('CANDIDATE_REPOSITORY_INVALID');
  const result = await generateCandidate(request.facts.baseSha, { configPath: 'release-please-config.json', manifestPath: '.release-please-manifest.json',
    units: request.units, readFacts: async () => request.facts, createReadClient: () => GitHub.create({ owner, repo, token }) });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ status: 'FAILED', errorCode: error instanceof Error && /^CANDIDATE_[A-Z_]+$/.test(error.message) ? error.message : 'CANDIDATE_GENERATION_UNAVAILABLE' }) + '\n');
  process.exitCode = 1;
}
