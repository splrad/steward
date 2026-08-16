export interface ParsedVersion { displayVersion: string; buildId: string; displayParts: [number, number, number]; buildParts: [number, number] }
export interface ReleaseAsset { name: string; size: number; sha256: string }
export interface ReleaseManifest { schemaVersion: 1; repositoryId: number; targetSha: string; policySha: string; displayVersion: string; buildId: string; assets: ReleaseAsset[] }

function tupleGreater(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0; const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

export function parseVersion(displayVersion: string, buildId: string): ParsedVersion {
  if (!/^\d+\.\d+\.\d+$/.test(displayVersion) || !/^\d{8}\.\d+$/.test(buildId)) throw new Error('版本或构建编号格式无效');
  const display = displayVersion.split('.').map(Number) as [number, number, number];
  const build = buildId.split('.').map(Number) as [number, number];
  return { displayVersion, buildId, displayParts: display, buildParts: build };
}

export function planRelease(input: { next: ParsedVersion; previous?: ParsedVersion | null; targetSha: string }): { tag: string; title: string; targetSha: string } {
  if (!/^[0-9a-f]{40}$/i.test(input.targetSha)) throw new Error('目标提交必须是40位提交编号');
  if (input.previous && (!tupleGreater(input.next.displayParts, input.previous.displayParts) || !tupleGreater(input.next.buildParts, input.previous.buildParts))) throw new Error('版本和构建编号必须严格增长');
  return { tag: `v${input.next.displayVersion}`, title: `AFR v${input.next.displayVersion} (${input.next.buildId})`, targetSha: input.targetSha };
}

export function verifyAssetManifest(manifest: ReleaseManifest, expectedNames: readonly string[]): void {
  if (manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.repositoryId) || !/^[0-9a-f]{40}$/i.test(manifest.targetSha) || !/^[0-9a-f]{40}$/i.test(manifest.policySha)) throw new Error('发布清单基础字段无效');
  if (manifest.assets.length !== expectedNames.length) throw new Error('发布资产数量不正确');
  const expected = new Set(expectedNames);
  if (expected.size !== expectedNames.length || new Set(manifest.assets.map(asset => asset.name)).size !== manifest.assets.length) throw new Error('发布资产名称重复');
  for (const asset of manifest.assets) {
    if (!expected.has(asset.name) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`发布资产无效: ${asset.name}`);
  }
}

export type RemoteReleaseState =
  | { state: 'create-draft' }
  | { state: 'resume-draft'; releaseId: number }
  | { state: 'already-complete'; releaseId: number }
  | { state: 'conflict'; reason: string };

export function classifyRemoteReleaseState(input: { tagExists: boolean; release?: { id: number; draft: boolean; prerelease: boolean; targetMatches: boolean; titleMatches: boolean; markerMatches: boolean; assetsMatch: boolean; hasUnexpectedAssets: boolean } | null }): RemoteReleaseState {
  const release = input.release;
  if (!input.tagExists && !release) return { state: 'create-draft' };
  if (input.tagExists && !release) return { state: 'conflict', reason: '标签存在但发布不存在' };
  if (!input.tagExists && release) return { state: 'conflict', reason: '发布存在但标签不存在' };
  if (!release || release.prerelease || !release.targetMatches || !release.titleMatches || !release.markerMatches || release.hasUnexpectedAssets) return { state: 'conflict', reason: '远程发布与当前计划不一致' };
  if (release.draft) return { state: 'resume-draft', releaseId: release.id };
  return release.assetsMatch ? { state: 'already-complete', releaseId: release.id } : { state: 'conflict', reason: '已发布资产不一致' };
}
