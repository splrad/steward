import { sha256HexUtf8 } from '../../manifest/src/digest.js';

type ControlJsonValue =
  | null
  | boolean
  | number
  | string
  | ControlJsonValue[]
  | { [key: string]: ControlJsonValue };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalControlValue(
  value: unknown,
  path: string,
): ControlJsonValue {
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) =>
      canonicalControlValue(child, `${path}/${index}`),
    );
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [
          key,
          canonicalControlValue(child, `${path}/${key}`),
        ]),
    );
  }
  throw new TypeError(`${path} is not JSON serializable`);
}

export function canonicalControlJson(value: unknown): string {
  return JSON.stringify(canonicalControlValue(value, '$'));
}

export function controlJsonDigest(value: unknown): Promise<string> {
  return sha256HexUtf8(canonicalControlJson(value));
}
