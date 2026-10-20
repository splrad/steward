import { canonicalReleaseJson, receiptDigest, releaseAssert } from '../../core/src/release-note-receipt.js';
import { dispatchWorkflow } from '../../github/src/index.js';
import { centralBuildClient } from './release-build-api.js';
import type { BodyWriteRuntimeEnv } from './pr-body-api.js';

export async function dispatchMigrationBuild(env: BodyWriteRuntimeEnv, inputs: Record<string, string>): Promise<void> {
  const policy = env.POLICY_SHA!;
  const key = receiptDigest(canonicalReleaseJson({ policy, inputs }));
  const db = env.ISSUE_SNAPSHOTS!;
  const gh = await centralBuildClient(env, true);
  // Reserve before the external POST. A lost response or process exit must never
  // turn a retry into a second dispatch, including concurrent callers.
  const reserved = await db.prepare('INSERT OR IGNORE INTO release_migration_dispatches(dispatch_key) VALUES(?)').bind(key).run();
  if (reserved.meta.changes === 1) {
    await dispatchWorkflow(gh, { owner: 'splrad', repo: 'steward', workflow: 'release-build.yml', policySha: policy, inputs: { ...inputs, dispatchKey: key } });
  } else {
    const intent = await db.prepare('SELECT confirmed FROM release_migration_dispatches WHERE dispatch_key=?').bind(key).first<{ confirmed: number }>();
    if (intent?.confirmed === 1) return;
    let total: number | undefined;
    const runs = await gh.paginate<any>(`/repos/splrad/steward/actions/workflows/release-build.yml/runs?event=workflow_dispatch&head_sha=${policy}&per_page=100`, value => {
      const page = value as any;
      releaseAssert(Number.isSafeInteger(page.total_count) && page.total_count >= 0 && page.total_count < 1000
        && (total === undefined || total === page.total_count), 'MIGRATION_DISPATCH_HISTORY');
      total = page.total_count;
      return page.workflow_runs;
    }, { maxPages: 10, maxItems: 999 });
    releaseAssert(runs.length === total && new Set(runs.map(run => run.id)).size === runs.length, 'MIGRATION_DISPATCH_HISTORY');
    const matches = runs.filter(run => run.repository?.id === 1296724484 && run.event === 'workflow_dispatch'
      && run.head_sha === policy && run.path === '.github/workflows/release-build.yml'
      && run.display_title === `build:${inputs.repositoryId}:${inputs.targetTag}::${key}`);
    // Absence is not evidence that GitHub rejected the POST (eventual visibility).
    // Keep the intent for readback or operator recovery; never blindly resend.
    releaseAssert(matches.length === 1, 'MIGRATION_DISPATCH_UNKNOWN');
  }
  await db.prepare('UPDATE release_migration_dispatches SET confirmed=1 WHERE dispatch_key=?').bind(key).run();
}
