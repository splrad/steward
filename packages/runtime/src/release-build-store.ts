import { canonicalReleaseJson, releaseAssert, positiveId } from '../../core/src/release-note-receipt.js';
import { type ReleaseBuildRequest, type ReleaseBuildState } from '../../core/src/release-build-request.js';
export class ReleaseBuildStore {
  constructor(private readonly db: D1Database) {}
  async find(repositoryId: number, tag: string, runId: number, attempt: number): Promise<ReleaseBuildState | null> {
    const rows = await this.db.prepare("SELECT record_json FROM release_build_requests WHERE repository_id=? AND target_tag=? AND EXISTS(SELECT 1 FROM json_each(json_extract(record_json,'$.attempts')) WHERE json_extract(value,'$.runId')=? AND json_extract(value,'$.attempt')=?)")
      .bind(repositoryId, tag, runId, attempt).all<{ record_json: string }>();
    releaseAssert(rows.results.length <= 1, 'BUILD_RUN_AMBIGUOUS'); return rows.results[0] ? JSON.parse(rows.results[0].record_json) : null;
  }
  async get(key: string, repositoryId: number, tag: string): Promise<ReleaseBuildState | null> {
    const row = await this.db.prepare('SELECT record_json FROM release_build_requests WHERE request_key=? AND repository_id=? AND target_tag=?').bind(key, repositoryId, tag).first<{ record_json: string }>();
    return row ? JSON.parse(row.record_json) : null;
  }
  async prepare(request: ReleaseBuildRequest): Promise<ReleaseBuildState> {
    const existing = await this.get(request.key, request.frozen.repositoryId, request.frozen.targetTag);
    if (existing) {
      releaseAssert(existing.status !== 'superseded' && canonicalReleaseJson(existing.request) === canonicalReleaseJson(request), 'BUILD_REQUEST_OCCUPIED');
      return existing;
    }
    if (request.mode === 'initial') {
      const row = await this.db.prepare("SELECT record_json FROM release_build_requests WHERE repository_id=? AND target_tag=? AND json_extract(record_json,'$.request.mode')='initial' AND json_extract(record_json,'$.status')!='superseded'")
        .bind(request.frozen.repositoryId, request.frozen.targetTag).first<{ record_json: string }>();
      if (row) return this.restart(JSON.parse(row.record_json), request);
    }
    const state: ReleaseBuildState = { request, version: 0, status: 'requested', attempts: [], artifact: null, error: null };
    const text = canonicalReleaseJson(state); releaseAssert(Buffer.byteLength(text) <= 512 * 1024, 'BUILD_REQUEST_LIMIT');
    await this.db.prepare('INSERT OR IGNORE INTO release_build_requests(request_key,repository_id,target_tag,record_json) VALUES(?,?,?,?)').bind(request.key, request.frozen.repositoryId, request.frozen.targetTag, text).run();
    const current = (await this.get(request.key, request.frozen.repositoryId, request.frozen.targetTag))!;
    releaseAssert(current && current.status !== 'superseded' && canonicalReleaseJson(current.request) === canonicalReleaseJson(request), 'BUILD_REQUEST_OCCUPIED'); return current;
  }
  private async restart(previous: ReleaseBuildState, request: ReleaseBuildRequest): Promise<ReleaseBuildState> {
    const old = previous.request, f = request.frozen;
    releaseAssert(['requested', 'running', 'failed'].includes(previous.status)
      && (old.frozen.policySha !== f.policySha || old.frozen.productTargetSha !== f.productTargetSha), 'BUILD_REQUEST_OCCUPIED');
    const restartCount = (previous.restartCount ?? 0) + 1;
    releaseAssert(restartCount <= 3, 'BUILD_RESTART_BUDGET');
    const archived: ReleaseBuildState = { ...previous, version: previous.version + 1, status: 'superseded', supersededBy: request.key };
    const next: ReleaseBuildState = { request, version: 0, restartCount, status: 'requested', attempts: [], artifact: null, error: null };
    const archivedText = canonicalReleaseJson(archived), nextText = canonicalReleaseJson(next);
    releaseAssert(Math.max(Buffer.byteLength(archivedText), Buffer.byteLength(nextText)) <= 512 * 1024, 'BUILD_REQUEST_LIMIT');
    // D1 batch is atomic. The insert depends on the exact archived version, so a
    // competing completion/replacement cannot leave a second active request.
    await this.db.batch([
      this.db.prepare("UPDATE release_build_requests SET record_json=?,version=? WHERE request_key=? AND version=? AND json_extract(record_json,'$.status') IN ('requested','running','failed') AND NOT EXISTS(SELECT 1 FROM release_receipts WHERE repository_id=? AND target_tag=?) AND NOT EXISTS(SELECT 1 FROM release_build_requests WHERE request_key=?)")
        .bind(archivedText, archived.version, old.key, previous.version, f.repositoryId, f.targetTag, request.key),
      this.db.prepare("INSERT OR IGNORE INTO release_build_requests(request_key,repository_id,target_tag,record_json) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM release_build_requests WHERE request_key=? AND version=? AND json_extract(record_json,'$.supersededBy')=?)")
        .bind(request.key, f.repositoryId, f.targetTag, nextText, old.key, archived.version, request.key),
    ]);
    const current = await this.get(request.key, f.repositoryId, f.targetTag);
    releaseAssert(current && current.status !== 'superseded' && canonicalReleaseJson(current.request) === canonicalReleaseJson(request), 'BUILD_REQUEST_STALE');
    return current;
  }
  async save(previous: ReleaseBuildState, next: ReleaseBuildState): Promise<ReleaseBuildState> {
    releaseAssert(previous.status !== 'superseded' && next.status !== 'superseded'
      && previous.restartCount === next.restartCount && previous.supersededBy === next.supersededBy, 'BUILD_REQUEST_STALE');
    releaseAssert(canonicalReleaseJson(previous.request) === canonicalReleaseJson(next.request), 'BUILD_REQUEST_IMMUTABLE');
    const saved = { ...next, version: previous.version + 1 }, r = previous.request;
    releaseAssert(Buffer.byteLength(canonicalReleaseJson(saved)) <= 512 * 1024, 'BUILD_REQUEST_LIMIT');
    const result = await this.db.prepare('UPDATE release_build_requests SET record_json=?,version=? WHERE request_key=? AND repository_id=? AND target_tag=? AND version=?')
      .bind(canonicalReleaseJson(saved), saved.version, r.key, r.frozen.repositoryId, r.frozen.targetTag, previous.version).run();
    releaseAssert(result.meta.changes === 1, 'BUILD_REQUEST_STALE'); return saved;
  }
  async begin(current: ReleaseBuildState, runId: number, attempt: number): Promise<ReleaseBuildState> {
    releaseAssert(positiveId(runId) && positiveId(attempt), 'BUILD_RUN');
    const last = current.attempts.at(-1);
    if (current.status === 'running' && last?.runId === runId && last.attempt === attempt) return current;
    releaseAssert(['requested', 'failed'].includes(current.status) && current.attempts.length < 3
      && !current.attempts.some(a => a.runId === runId && a.attempt === attempt), 'BUILD_RETRY_BUDGET');
    return this.save(current, { ...current, status: 'running', attempts: [...current.attempts, { runId, attempt }], error: null });
  }
}
