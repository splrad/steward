import { createHmac, timingSafeEqual, type Hmac } from 'node:crypto';
import Tokenizer from '@streamparser/json/tokenizer.js';
import TokenType from '@streamparser/json/utils/types/tokenType.js';

export const MAX_LARGE_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;
export const MAX_STREAMED_REPOSITORY_IDS = 5_000;
export const MAX_STREAMED_JSON_DEPTH = 64;
export const MAX_STREAMED_JSON_KEY_BYTES = 1_024;
export const MAX_STREAMED_JSON_STRING_BYTES = 256 * 1024;
export const MAX_STREAMED_JSON_PRIMITIVE_BYTES = 128;
export const MAX_STREAMED_SELECTED_STRING_BYTES = 1_024;

export const STREAMING_WEBHOOK_EVENTS: ReadonlySet<string> = new Set([
  'custom_property',
  'custom_property_values',
  'membership',
  'team',
  'team_add',
  'push',
  'installation',
  'installation_repositories',
  'installation_target',
]);

type JsonRecord = Record<string, unknown>;
type PathPart = string | number;
type ProjectedValueKind = 'object' | 'array';

class JsonCapacityError extends Error {}

const utf8Encoder = new TextEncoder();

class JsonLexicalCapacityGuard {
  private escaped = false;
  private inString = false;
  private primitiveBytes = 0;
  private stringBytes = 0;

  write(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (this.inString) {
        if (!this.escaped && byte === 0x22) {
          this.inString = false;
          this.stringBytes = 0;
          continue;
        }
        this.stringBytes += 1;
        if (this.stringBytes > MAX_STREAMED_JSON_STRING_BYTES) {
          throw new JsonCapacityError('JSON string token exceeds limit');
        }
        if (this.escaped) {
          this.escaped = false;
        } else if (byte === 0x5c) {
          this.escaped = true;
        }
        continue;
      }

      if (byte === 0x22) {
        this.inString = true;
        this.escaped = false;
        this.stringBytes = 0;
        this.primitiveBytes = 0;
        continue;
      }
      if (
        byte === 0x20
        || byte === 0x09
        || byte === 0x0a
        || byte === 0x0d
        || byte === 0x7b
        || byte === 0x7d
        || byte === 0x5b
        || byte === 0x5d
        || byte === 0x3a
        || byte === 0x2c
      ) {
        this.primitiveBytes = 0;
        continue;
      }
      this.primitiveBytes += 1;
      if (this.primitiveBytes > MAX_STREAMED_JSON_PRIMITIVE_BYTES) {
        throw new JsonCapacityError('JSON primitive token exceeds limit');
      }
    }
  }
}

interface ObjectFrame {
  readonly kind: 'object';
  readonly path: readonly PathPart[];
  state: 'key' | 'key-or-end' | 'colon' | 'value' | 'comma';
  key: string | undefined;
}

interface ArrayFrame {
  readonly kind: 'array';
  readonly path: readonly PathPart[];
  state: 'value' | 'value-or-end' | 'comma';
  index: number;
}

type Frame = ObjectFrame | ArrayFrame;

interface ParsedToken {
  readonly token: TokenType;
  readonly value: boolean | null | number | string;
}

const projectedPathsByEvent: Readonly<Record<string, readonly (readonly string[])[]>> = {
  custom_property: [
    ['action'],
    ['installation', 'id'],
    ['definition', 'property_name'],
  ],
  custom_property_values: [
    ['action'],
    ['installation', 'id'],
    ['repository', 'id'],
  ],
  membership: [
    ['action'],
    ['installation', 'id'],
    ['scope'],
    ['team', 'id'],
    ['member', 'id'],
  ],
  team: [
    ['action'],
    ['installation', 'id'],
    ['repository', 'id'],
    ['team', 'id'],
    ['changes', 'repository', 'permissions'],
  ],
  team_add: [
    ['action'],
    ['installation', 'id'],
    ['repository', 'id'],
    ['team', 'id'],
  ],
  push: [
    ['action'],
    ['installation', 'id'],
    ['repository', 'id'],
    ['ref'],
  ],
  installation: [
    ['action'],
    ['installation', 'id'],
    ['repositories'],
  ],
  installation_repositories: [
    ['action'],
    ['installation', 'id'],
    ['repositories_added'],
    ['repositories_removed'],
  ],
  installation_target: [
    ['action'],
    ['target_type'],
    ['account', 'id'],
    ['installation', 'id'],
    ['installation', 'account', 'id'],
    ['changes'],
  ],
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function projectedContainer(kind: ProjectedValueKind): JsonRecord | unknown[] {
  return kind === 'object' ? {} : [];
}

function pathEquals(
  left: readonly PathPart[],
  right: readonly PathPart[],
): boolean {
  return left.length === right.length
    && left.every((part, index) => part === right[index]);
}

function pathIsPrefix(
  path: readonly PathPart[],
  selected: readonly string[],
): boolean {
  return path.length <= selected.length
    && path.every((part, index) => part === selected[index]);
}

function setProjectedPath(
  root: JsonRecord,
  path: readonly PathPart[],
  value: unknown,
): void {
  if (path.length === 0 || typeof path[0] !== 'string') return;
  let parent: JsonRecord = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index];
    if (typeof part !== 'string') return;
    const existing = record(parent[part]);
    if (existing === null) return;
    parent = existing;
  }
  const last = path[path.length - 1];
  if (typeof last === 'string') parent[last] = value;
}

class SelectivePayloadProjector {
  private readonly selectedPaths: readonly (readonly string[])[];
  private payload: unknown;
  private scalarCapacityValid = true;
  private readonly overflowedCollections = new Set<string>();

  constructor(event: string) {
    this.selectedPaths = projectedPathsByEvent[event] ?? [];
  }

  value(
    path: readonly PathPart[],
    value: unknown,
  ): void {
    this.capture(path, value);
  }

  container(
    path: readonly PathPart[],
    kind: ProjectedValueKind,
  ): void {
    this.capture(path, projectedContainer(kind), kind);
  }

  result(): {
    readonly payload: unknown;
    readonly projectionValid: boolean;
  } {
    const root = record(this.payload);
    const action = root?.action;
    const collectionOverflowRelevant =
      this.overflowedCollections.has('repositories_added')
      || this.overflowedCollections.has('repositories_removed')
      || (
        this.overflowedCollections.has('repositories')
        && (action === 'suspend' || action === 'deleted')
      );
    return {
      payload: this.payload,
      projectionValid:
        this.scalarCapacityValid && !collectionOverflowRelevant,
    };
  }

  private capture(
    path: readonly PathPart[],
    value: unknown,
    kind?: ProjectedValueKind,
  ): void {
    if (path.length === 0) {
      this.payload = kind === 'object' ? {} : null;
      return;
    }

    const root = record(this.payload);
    if (root === null) return;

    const matchingPaths = this.selectedPaths.filter(
      (selected) => pathIsPrefix(path, selected),
    );
    if (matchingPaths.length > 0) {
      const exact = matchingPaths.some(
        (selected) => selected.length === path.length,
      );
      let projected: unknown;
      if (kind !== undefined) {
        projected = projectedContainer(kind);
      } else if (!exact) {
        // Preserve a genuine JSON null because some webhook schemas allow it
        // (for example membership.member). Any other scalar where an object
        // is required must remain observably malformed across the 1 MiB
        // buffered/streamed boundary.
        projected = value === null ? null : false;
      } else if (path[path.length - 1] === 'id') {
        projected = typeof value === 'number' ? value : null;
      } else if (typeof value === 'string') {
        if (
          utf8Encoder.encode(value).byteLength
          > MAX_STREAMED_SELECTED_STRING_BYTES
        ) {
          this.scalarCapacityValid = false;
          projected = null;
        } else {
          projected = value;
        }
      } else {
        projected = null;
      }
      setProjectedPath(root, path, projected);
    }

    const collectionName = path[0];
    if (
      typeof collectionName !== 'string'
      || ![
        'repositories',
        'repositories_added',
        'repositories_removed',
      ].includes(collectionName)
      || typeof path[1] !== 'number'
    ) {
      return;
    }

    const collection = root[collectionName];
    if (!Array.isArray(collection)) return;
    const index = path[1];
    if (index >= MAX_STREAMED_REPOSITORY_IDS) {
      this.overflowedCollections.add(collectionName);
      return;
    }

    if (path.length === 2) {
      collection[index] = kind === undefined
        ? null
        : projectedContainer(kind);
      return;
    }
    if (
      path.length === 3
      && path[2] === 'id'
      && record(collection[index]) !== null
    ) {
      (collection[index] as JsonRecord).id =
        typeof value === 'number' ? value : null;
      return;
    }

    // A nested object or array at repository.id must remain malformed in the
    // bounded projection; it must never disappear into a valid-looking item.
    if (
      path.length === 3
      && path[2] === 'id'
      && kind !== undefined
    ) {
      const item = record(collection[index]);
      if (item !== null) item.id = projectedContainer(kind);
    }
  }
}

class JsonStructureObserver {
  private readonly frames: Frame[] = [];
  private rootState: 'value' | 'done' = 'value';

  constructor(private readonly projector: SelectivePayloadProjector) {}

  write(parsed: ParsedToken): void {
    if (parsed.token === TokenType.SEPARATOR) return;
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) {
      if (this.rootState === 'value') {
        this.rootState = 'done';
        this.consumeValue([], parsed);
        return;
      }
      throw new SyntaxError('Unexpected token after top-level JSON value');
    }
    if (frame.kind === 'object') {
      this.writeObject(frame, parsed);
    } else {
      this.writeArray(frame, parsed);
    }
  }

  finish(): void {
    if (this.rootState !== 'done' || this.frames.length !== 0) {
      throw new SyntaxError('JSON document ended before its value was complete');
    }
  }

  private writeObject(frame: ObjectFrame, parsed: ParsedToken): void {
    if (frame.state === 'key-or-end') {
      if (parsed.token === TokenType.STRING) {
        if (
          utf8Encoder.encode(String(parsed.value)).byteLength
          > MAX_STREAMED_JSON_KEY_BYTES
        ) {
          throw new JsonCapacityError('JSON object key exceeds limit');
        }
        frame.key = String(parsed.value);
        frame.state = 'colon';
      } else if (parsed.token === TokenType.RIGHT_BRACE) {
        this.frames.pop();
      } else {
        throw new SyntaxError('Expected an object key or closing brace');
      }
      return;
    }
    if (frame.state === 'key') {
      if (parsed.token === TokenType.STRING) {
        if (
          utf8Encoder.encode(String(parsed.value)).byteLength
          > MAX_STREAMED_JSON_KEY_BYTES
        ) {
          throw new JsonCapacityError('JSON object key exceeds limit');
        }
        frame.key = String(parsed.value);
        frame.state = 'colon';
      } else if (parsed.token === TokenType.RIGHT_BRACE) {
        throw new SyntaxError('Trailing comma in JSON object');
      } else {
        throw new SyntaxError('Expected an object key');
      }
      return;
    }
    if (frame.state === 'colon') {
      if (parsed.token !== TokenType.COLON) {
        throw new SyntaxError('Expected a colon after an object key');
      }
      frame.state = 'value';
      return;
    }
    if (frame.state === 'value') {
      const key = frame.key;
      if (key === undefined) throw new SyntaxError('Object key was unavailable');
      frame.state = 'comma';
      this.consumeValue([...frame.path, key], parsed);
      return;
    }
    if (parsed.token === TokenType.COMMA) {
      frame.key = undefined;
      frame.state = 'key';
    } else if (parsed.token === TokenType.RIGHT_BRACE) {
      this.frames.pop();
    } else {
      throw new SyntaxError('Expected a comma or closing brace');
    }
  }

  private writeArray(frame: ArrayFrame, parsed: ParsedToken): void {
    if (frame.state === 'value-or-end') {
      if (parsed.token === TokenType.RIGHT_BRACKET) {
        this.frames.pop();
        return;
      }
      frame.state = 'comma';
      this.consumeValue([...frame.path, frame.index], parsed);
      return;
    }
    if (frame.state === 'value') {
      if (parsed.token === TokenType.RIGHT_BRACKET) {
        throw new SyntaxError('Trailing comma in JSON array');
      }
      frame.state = 'comma';
      this.consumeValue([...frame.path, frame.index], parsed);
      return;
    }
    if (parsed.token === TokenType.COMMA) {
      frame.index += 1;
      frame.state = 'value';
    } else if (parsed.token === TokenType.RIGHT_BRACKET) {
      this.frames.pop();
    } else {
      throw new SyntaxError('Expected a comma or closing bracket');
    }
  }

  private consumeValue(
    path: readonly PathPart[],
    parsed: ParsedToken,
  ): void {
    if (parsed.token === TokenType.LEFT_BRACE) {
      if (this.frames.length >= MAX_STREAMED_JSON_DEPTH) {
        throw new JsonCapacityError('JSON nesting depth exceeds limit');
      }
      this.projector.container(path, 'object');
      this.frames.push({
        kind: 'object',
        path,
        state: 'key-or-end',
        key: undefined,
      });
      return;
    }
    if (parsed.token === TokenType.LEFT_BRACKET) {
      if (this.frames.length >= MAX_STREAMED_JSON_DEPTH) {
        throw new JsonCapacityError('JSON nesting depth exceeds limit');
      }
      this.projector.container(path, 'array');
      this.frames.push({
        kind: 'array',
        path,
        state: 'value-or-end',
        index: 0,
      });
      return;
    }
    if (
      parsed.token === TokenType.STRING
      || parsed.token === TokenType.NUMBER
      || parsed.token === TokenType.TRUE
      || parsed.token === TokenType.FALSE
      || parsed.token === TokenType.NULL
    ) {
      this.projector.value(path, parsed.value);
      return;
    }
    throw new SyntaxError('Expected a JSON value');
  }
}

function digestMatches(expected: Uint8Array, actual: Uint8Array): boolean {
  return expected.byteLength === actual.byteLength
    && timingSafeEqual(expected, actual);
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      value.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

export interface StreamedBroadWebhookResult {
  readonly capacityValid: boolean;
  readonly jsonValid: boolean;
  readonly payload: unknown;
  readonly projectionValid: boolean;
  readonly signatureValid: boolean;
}

/**
 * Incrementally authenticates a large GitHub delivery while a tokenizer and
 * strict structure observer validate the entire JSON document. Only fields
 * needed by the broad event extractors are projected, so commit arrays are
 * never retained.
 */
export class StreamedBroadWebhookProcessor {
  private readonly currentHmac: Hmac;
  private readonly previousHmac?: Hmac;
  private readonly tokenizer: Tokenizer;
  private readonly observer: JsonStructureObserver;
  private readonly projector: SelectivePayloadProjector;
  private readonly lexicalCapacityGuard = new JsonLexicalCapacityGuard();
  private readonly utf8Validator = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: false,
  });
  private capacityValid = true;
  private syntaxValid = true;
  private utf8Valid = true;

  constructor(
    event: string,
    currentSecret: string,
    previousSecret?: string,
  ) {
    this.currentHmac = createHmac('sha256', currentSecret);
    if (previousSecret !== undefined && previousSecret.length > 0) {
      this.previousHmac = createHmac('sha256', previousSecret);
    }
    this.projector = new SelectivePayloadProjector(event);
    this.observer = new JsonStructureObserver(this.projector);
    this.tokenizer = new Tokenizer({
      numberBufferSize: 64,
      stringBufferSize: 64 * 1024,
    });
    this.tokenizer.onToken = (parsed) => {
      this.observer.write(parsed);
    };
  }

  write(chunk: Uint8Array): void {
    this.currentHmac.update(chunk);
    this.previousHmac?.update(chunk);
    for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
      const slice = chunk.subarray(offset, offset + 64 * 1024);
      if (this.utf8Valid) {
        try {
          this.utf8Validator.decode(slice, { stream: true });
        } catch {
          this.utf8Valid = false;
        }
      }
      if (!this.capacityValid || !this.syntaxValid || !this.utf8Valid) {
        continue;
      }
      try {
        this.lexicalCapacityGuard.write(slice);
        this.tokenizer.write(slice);
      } catch (error) {
        if (error instanceof JsonCapacityError) {
          this.capacityValid = false;
        } else {
          this.syntaxValid = false;
        }
      }
    }
  }

  finish(signature: string): StreamedBroadWebhookResult {
    if (this.utf8Valid) {
      try {
        this.utf8Validator.decode();
      } catch {
        this.utf8Valid = false;
      }
    }
    if (this.capacityValid && this.syntaxValid && this.utf8Valid) {
      try {
        this.tokenizer.end();
        this.observer.finish();
      } catch (error) {
        if (error instanceof JsonCapacityError) {
          this.capacityValid = false;
        } else {
          this.syntaxValid = false;
        }
      }
    }

    const expected = hexBytes(signature.slice('sha256='.length));
    const currentValid = digestMatches(expected, this.currentHmac.digest());
    const previousValid = this.previousHmac === undefined
      ? false
      : digestMatches(expected, this.previousHmac.digest());
    const projected = this.projector.result();
    return {
      capacityValid: this.capacityValid,
      jsonValid: this.utf8Valid && (
        !this.capacityValid || this.syntaxValid
      ),
      payload: projected.payload,
      projectionValid: projected.projectionValid,
      signatureValid: currentValid || previousValid,
    };
  }
}
