export class ReleaseVersionError extends Error {
  constructor(public readonly code: 'RN_VERSION_INVALID' | 'RN_VERSION_NOT_INCREASING' | 'RN_VERSION_CONFLICT') {
    super(code);
    this.name = 'ReleaseVersionError';
  }
}

export interface PublicVersion { value: string; parts: readonly [string, string, string] }

export function parsePublicVersion(value: string): PublicVersion {
  if (/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(value)?.[0] !== value) {
    throw new ReleaseVersionError('RN_VERSION_INVALID');
  }
  return { value, parts: value.split('.') as [string, string, string] };
}

export function parseVersionFile(bytes: Uint8Array): PublicVersion {
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ReleaseVersionError('RN_VERSION_INVALID'); }
  if (!source.endsWith('\n')) throw new ReleaseVersionError('RN_VERSION_INVALID');
  return parsePublicVersion(source.slice(0, -1));
}

export function comparePublicVersions(left: PublicVersion, right: PublicVersion): -1 | 0 | 1 {
  const a = parsePublicVersion(left.value).parts;
  const b = parsePublicVersion(right.value).parts;
  for (let index = 0; index < 3; index++) {
    const x = a[index]!; const y = b[index]!;
    if (x !== y) return x.length !== y.length ? (x.length > y.length ? 1 : -1) : (x > y ? 1 : -1);
  }
  return 0;
}

export function planPublicRelease(input: {
  versionBytes: Uint8Array;
  previousVersion?: string;
  targetSha: string;
  existingTagTargetSha?: string;
  existingPackageTargetShas?: readonly string[];
}): { version: PublicVersion; tag: string; title: string; targetSha: string } {
  if (input.targetSha.length !== 40 || !/^[0-9a-f]{40}$/u.test(input.targetSha)) throw new ReleaseVersionError('RN_VERSION_INVALID');
  const version = parseVersionFile(input.versionBytes);
  if (input.previousVersion !== undefined && comparePublicVersions(version, parsePublicVersion(input.previousVersion)) <= 0) {
    throw new ReleaseVersionError('RN_VERSION_NOT_INCREASING');
  }
  for (const sha of [input.existingTagTargetSha, ...(input.existingPackageTargetShas ?? [])]) {
    if (sha !== undefined && sha !== input.targetSha) throw new ReleaseVersionError('RN_VERSION_CONFLICT');
  }
  return { version, tag: `v${version.value}`, title: `v${version.value}`, targetSha: input.targetSha };
}

export function assertNativeVersion(version: PublicVersion, nativeVersion: string): void {
  if (parsePublicVersion(nativeVersion).value !== parsePublicVersion(version.value).value) {
    throw new ReleaseVersionError('RN_VERSION_CONFLICT');
  }
}
