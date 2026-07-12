import { createGitHubRestTransport } from '../../github/src/index.js';
import { runDoctor, type DoctorReport } from './doctor.js';

interface Arguments {
  repository: string;
  pullRequest?: number;
  json: boolean;
}

function usage(): string {
  return 'Usage: steward doctor --repo OWNER/REPOSITORY [--pr NUMBER] [--json]';
}

export function parseArguments(argv: readonly string[]): Arguments {
  if (argv[0] !== 'doctor') throw new Error(usage());
  let repository = '';
  let pullRequest: number | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument === '--repo') repository = String(argv[++index] ?? '');
    else if (argument === '--pr') {
      const value = Number(argv[++index] ?? 0);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('--pr must be a positive integer');
      pullRequest = value;
    } else throw new Error(`Unknown argument: ${argument ?? ''}\n${usage()}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`--repo must be OWNER/REPOSITORY\n${usage()}`);
  return { repository, ...(pullRequest === undefined ? {} : { pullRequest }), json };
}

function render(report: DoctorReport): string {
  const lines = [`Steward doctor: ${report.repository}`];
  for (const item of report.findings) {
    lines.push(`[${item.level.toUpperCase()}] ${item.code}: ${item.summary}`);
    if (item.remedy) lines.push(`  修复：${item.remedy}`);
  }
  lines.push(`Summary: ${report.counts.pass} pass, ${report.counts.warning} warning, ${report.counts.fail} fail`);
  return lines.join('\n');
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const args = parseArguments(argv);
    const token = String(env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '').trim();
    if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
    const [owner, repository] = args.repository.split('/') as [string, string];
    const report = await runDoctor(createGitHubRestTransport({ token, userAgent: 'splrad-steward-cli' }), {
      owner, repository, ...(args.pullRequest === undefined ? {} : { pullRequest: args.pullRequest }),
    });
    process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : render(report)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`steward: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
