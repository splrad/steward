import { describe, expect, it } from 'vitest';
import { assertNativeVersion, comparePublicVersions, parsePublicVersion, parseVersionFile, planPublicRelease } from '../src/release-version.js';

const bytes = (value: string) => new TextEncoder().encode(value);
const targetSha = 'a'.repeat(40);

describe('root VERSION', () => {
  it.each(['0.0.0', '9.2.2', '100.20.300', '9007199254740993000000000.0.0'])('accepts %s', value => {
    expect(parseVersionFile(bytes(`${value}\n`)).value).toBe(value);
  });
  it.each(['', '1.2.3', '1.2.3\r\n', '\ufeff1.2.3\n', '1.2.3\n\n', ' 1.2.3\n', '1.2.3 \n', 'v1.2.3\n',
    '01.2.3\n', '1.02.3\n', '1.2.03\n', '-1.2.3\n', '1.2\n', '1.2.3.4\n', '1.2.3-beta\n', '1.2.3+build\n',
    '1.2.3 # comment\n', '1.2.3\n2.0.0\n', '１.2.3\n', '1.2.3\u0000\n'])('rejects malformed file %j', value => {
    expect(() => parseVersionFile(bytes(value))).toThrow('RN_VERSION_INVALID');
  });
  it('rejects malformed UTF-8', () => expect(() => parseVersionFile(new Uint8Array([0xc3, 0x28, 10]))).toThrow('RN_VERSION_INVALID'));
  it.each(['1.2.3\n', '1.2.3\r', '1.2.3 '])('rejects noncanonical value %j', value => {
    expect(() => parsePublicVersion(value)).toThrow('RN_VERSION_INVALID');
  });
  it.each([
    ['1.10.0', '1.9.999', 1], ['2.0.0', '1.999.999', 1], ['1.0.10', '1.0.9', 1],
    ['0.0.0', '0.0.0', 0], ['0.999.999', '1.0.0', -1],
    ['9007199254740993.0.0', '9007199254740992.0.0', 1],
    ['99999999999999999999.0.0', '100000000000000000000.0.0', -1],
  ] as const)('compares %s and %s', (a, b, expected) => {
    expect(comparePublicVersions(parsePublicVersion(a), parsePublicVersion(b))).toBe(expected);
  });
  it('plans a source release with a generic tag and title', () => {
    expect(planPublicRelease({ versionBytes: bytes('2.0.0\n'), previousVersion: '1.10.0', targetSha })).toMatchObject({ tag: 'v2.0.0', title: 'v2.0.0', targetSha });
  });
  it.each(['2.0.0', '2.0.1', '3.0.0'])('requires strict growth over %s', previousVersion => {
    expect(() => planPublicRelease({ versionBytes: bytes('2.0.0\n'), previousVersion, targetSha })).toThrow('RN_VERSION_NOT_INCREASING');
  });
  it('supports a first release with no predecessor', () => {
    expect(planPublicRelease({ versionBytes: bytes('0.0.0\n'), targetSha }).tag).toBe('v0.0.0');
  });
  it('accepts existing identities on the same commit', () => {
    expect(() => planPublicRelease({ versionBytes: bytes('1.0.0\n'), targetSha, existingTagTargetSha: targetSha, existingPackageTargetShas: [targetSha] })).not.toThrow();
  });
  it.each(['tag', 'package'])('rejects a conflicting %s identity', kind => {
    expect(() => planPublicRelease({ versionBytes: bytes('1.0.0\n'), targetSha,
      ...(kind === 'tag' ? { existingTagTargetSha: 'b'.repeat(40) } : { existingPackageTargetShas: ['b'.repeat(40)] }),
    })).toThrow('RN_VERSION_CONFLICT');
  });
  it('checks the target commit', () => expect(() => planPublicRelease({ versionBytes: bytes('1.0.0\n'), targetSha: 'short' })).toThrow('RN_VERSION_INVALID'));
  it('rejects a target commit with a trailing newline', () => expect(() => planPublicRelease({ versionBytes: bytes('1.0.0\n'), targetSha: `${targetSha}\n` })).toThrow('RN_VERSION_INVALID'));
  it('checks native projections', () => {
    const version = parsePublicVersion('1.2.3');
    expect(() => assertNativeVersion(version, '1.2.3')).not.toThrow();
    expect(() => assertNativeVersion(version, '1.2.4')).toThrow('RN_VERSION_CONFLICT');
    expect(() => assertNativeVersion(version, '01.2.3')).toThrow('RN_VERSION_INVALID');
  });
});
