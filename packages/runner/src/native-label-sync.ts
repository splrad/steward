import { NativeControlPlane } from './native-control-plane.js';
import { nativeGhCommand, type GhCommand } from './gh-release.js';
import { localGitSnapshot, type GitSnapshot } from './managed-sync-preview.js';
export interface AutoLabel { name: string; color: string; description: string }
function fail(detail: string): never { throw new Error('AUTO_LABELS: ' + detail); }
export function parseAutoLabels(value: any): AutoLabel[] {
  if (!value || Object.keys(value).sort().join(',') !== 'labels,schemaVersion' || value.schemaVersion !== 1 || !Array.isArray(value.labels) || !value.labels.length) fail('schema');
  const seen = new Set<string>();
  for (const label of value.labels) {
    if (!label || Object.keys(label).sort().join(',') !== 'color,description,name' || typeof label.name !== 'string' || !/^auto\/[a-z0-9][a-z0-9-]*$/.test(label.name)
      || typeof label.color !== 'string' || !/^[a-f0-9]{6}$/.test(label.color) || typeof label.description !== 'string' || label.description.length > 100 || /[\r\n\x00]/.test(label.description) || seen.has(label.name)) fail('definition');
    seen.add(label.name);
  }
  return structuredClone(value.labels);
}
type Preflight = Pick<NativeControlPlane, 'syncPreflight'>;
export class NativeLabelSync {
  constructor(private readonly gh: GhCommand = nativeGhCommand, private readonly plane: Preflight = new NativeControlPlane(gh), private readonly snapshots: GitSnapshot = localGitSnapshot) {}
  private async observed(fullName: string): Promise<AutoLabel[]> {
    const pages = JSON.parse(await this.gh(['api', '--paginate', '--slurp', `repos/${fullName}/labels?per_page=100`]));
    if (!Array.isArray(pages) || !pages.length || pages.some(p => !Array.isArray(p))) fail('incomplete inventory');
    const labels = pages.flat(), seen = new Set();
    for (const label of labels) {
      if (typeof label.name !== 'string' || typeof label.color !== 'string' || seen.has(label.name.toLowerCase())) fail('ambiguous inventory');
      seen.add(label.name.toLowerCase());
    }
    return labels.map(label => ({ name: label.name, color: label.color.toLowerCase(), description: label.description ?? '' }));
  }
  async run(repositoryId: number, policySha: string, directory: string, apply: boolean) {
    const current = await this.plane.syncPreflight(repositoryId, policySha);
    if (current.mode !== 'enabled') return { changed: false, writes: 0, mode: current.mode };
    if (await this.snapshots.head(directory) !== policySha) fail('policy checkout');
    const bytes = await this.snapshots.file(directory, policySha, 'config/labels/auto.json'); if (!bytes) fail('missing source');
    const definitions = parseAutoLabels(JSON.parse(bytes.toString('utf8'))), fullName = current.repository.fullName;
    const observed = await this.observed(fullName);
    const matches = (a: AutoLabel, b: AutoLabel) => a.name === b.name && a.color === b.color && a.description === b.description;
    const drift = definitions.filter(label => !observed.some(actual => matches(actual, label)));
    let writes = 0;
    if (apply) for (const label of drift) {
      const fresh = await this.plane.syncPreflight(repositoryId, policySha, current.expectedBaseSha);
      if (fresh.mode !== 'enabled' || fresh.repository.fullName !== fullName) fail('paused or changed target');
      let failure: unknown;
      try { await this.gh(['label', 'create', label.name, '--repo', fullName, '--color', label.color, '--description', label.description, '--force']); }
      catch (error) { failure = error; }
      if (!(await this.observed(fullName)).some(actual => matches(actual, label))) throw failure ?? new Error('AUTO_LABELS: readback mismatch');
      writes++;
    }
    return { changed: drift.length > 0, writes, mode: apply ? 'verified' : 'preview', labels: drift.map(label => label.name) };
  }
}
