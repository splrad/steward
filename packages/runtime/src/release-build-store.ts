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
    const state: ReleaseBuildState = { request, version: 0, status: 'requested', attempts: [], artifact: null, error: null };
    const text = canonicalReleaseJson(state); releaseAssert(Buffer.byteLength(text) <= 512 * 1024, 'BUILD_REQUEST_LIMIT');
    await this.db.prepare('INSERT OR IGNORE INTO release_build_requests(request_key,repository_id,target_tag,record_json) VALUES(?,?,?,?)').bind(request.key, request.frozen.repositoryId, request.frozen.targetTag, text).run();
    const current = (await this.get(request.key, request.frozen.repositoryId, request.frozen.targetTag))!;
    releaseAssert(current && canonicalReleaseJson(current.request) === canonicalReleaseJson(request), 'BUILD_REQUEST_OCCUPIED'); return current;
  }
  async save(previous: ReleaseBuildState, next: ReleaseBuildState): Promise<ReleaseBuildState> {
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
