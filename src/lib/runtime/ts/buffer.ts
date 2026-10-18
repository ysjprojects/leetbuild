/**
 * `Buffer` for the browser worker: kafkajs hands message keys and values to the learner as Buffers
 * (`message.value?.toString()`), grpc-js does the same for `bytes` fields, and learner code reaches
 * for `Buffer.from(...)`. Node already has one (`yarn verify`); the browser gets this subset —
 * `from`, `alloc`, `concat`, `isBuffer`, `byteLength`, `toString` (utf8/hex/base64/base64url/latin1),
 * `equals`, `toJSON`, `write`, 32-bit reads and writes — installed as the global when none exists.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Encoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'base64url' | 'latin1' | 'binary' | 'ascii';

const fromString = (text: string, encoding: Encoding = 'utf8'): Uint8Array => {
  switch (encoding) {
    case 'hex': {
      const out = new Uint8Array(Math.floor(text.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    case 'base64':
    case 'base64url': {
      const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    }
    case 'latin1':
    case 'binary':
    case 'ascii':
      return Uint8Array.from(text, c => c.charCodeAt(0) & 0xff);
    default:
      return encoder.encode(text);
  }
};

const compare = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
};

class BufferImpl extends Uint8Array {
  toString(encoding: Encoding = 'utf8', start = 0, end = this.length): string {
    const view = this.subarray(start, end);
    switch (encoding) {
      case 'hex':
        return [...view].map(b => b.toString(16).padStart(2, '0')).join('');
      case 'base64':
        return btoa(String.fromCharCode(...view));
      case 'base64url':
        return btoa(String.fromCharCode(...view))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      case 'latin1':
      case 'binary':
      case 'ascii':
        return String.fromCharCode(...view);
      default:
        return decoder.decode(view);
    }
  }

  toJSON(): {type: 'Buffer'; data: number[]} {
    return {type: 'Buffer', data: [...this]};
  }

  equals(other: Uint8Array): boolean {
    return MiniBuffer.compare(this, other) === 0;
  }

  compare(other: Uint8Array): number {
    return MiniBuffer.compare(this, other);
  }

  write(text: string, offset = 0, encoding: Encoding = 'utf8'): number {
    const bytes = fromString(text, encoding).subarray(0, Math.max(0, this.length - offset));
    this.set(bytes, offset);
    return bytes.length;
  }

  copy(target: Uint8Array, targetStart = 0, sourceStart = 0, sourceEnd = this.length): number {
    const view = this.subarray(sourceStart, Math.min(sourceEnd, sourceStart + target.length - targetStart));
    target.set(view, targetStart);
    return view.length;
  }

  indexOf(value: string | number | Uint8Array, byteOffset = 0): number {
    const needle =
      typeof value === 'number' ? Uint8Array.of(value) : typeof value === 'string' ? fromString(value) : value;
    outer: for (let i = byteOffset; i <= this.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  includes(value: string | number | Uint8Array, byteOffset = 0): boolean {
    return this.indexOf(value, byteOffset) !== -1;
  }

  readUInt32BE(offset = 0): number {
    return new DataView(this.buffer, this.byteOffset).getUint32(offset, false);
  }

  readUInt32LE(offset = 0): number {
    return new DataView(this.buffer, this.byteOffset).getUint32(offset, true);
  }

  readInt32BE(offset = 0): number {
    return new DataView(this.buffer, this.byteOffset).getInt32(offset, false);
  }

  writeUInt32BE(value: number, offset = 0): number {
    new DataView(this.buffer, this.byteOffset).setUint32(offset, value, false);
    return offset + 4;
  }

  writeUInt32LE(value: number, offset = 0): number {
    new DataView(this.buffer, this.byteOffset).setUint32(offset, value, true);
    return offset + 4;
  }

  writeInt32BE(value: number, offset = 0): number {
    new DataView(this.buffer, this.byteOffset).setInt32(offset, value, false);
    return offset + 4;
  }

  readUInt8(offset = 0): number {
    return this[offset];
  }

  writeUInt8(value: number, offset = 0): number {
    this[offset] = value & 0xff;
    return offset + 1;
  }
}

const wrap = (bytes: Uint8Array): BufferImpl => new BufferImpl(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The constructor side: `Buffer.from`, `alloc`, … — assigned onto the class so `Uint8Array.from`'s signature is not narrowed. */
const statics = {
  from(
    value: string | ArrayLike<number> | ArrayBuffer | Iterable<number>,
    encodingOrOffset?: Encoding | number,
    length?: number,
  ): BufferImpl {
    if (typeof value === 'string')
      return wrap(fromString(value, typeof encodingOrOffset === 'string' ? encodingOrOffset : 'utf8'));
    if (value instanceof ArrayBuffer)
      return new BufferImpl(value, typeof encodingOrOffset === 'number' ? encodingOrOffset : 0, length);
    return wrap(Uint8Array.from(value as ArrayLike<number>));
  },
  alloc(size: number, fill = 0): BufferImpl {
    const b = new BufferImpl(size);
    if (fill !== 0) b.fill(fill);
    return b;
  },
  allocUnsafe(size: number): BufferImpl {
    return new BufferImpl(size);
  },
  concat(list: Uint8Array[], totalLength?: number): BufferImpl {
    const total = totalLength ?? list.reduce((n, b) => n + b.length, 0);
    const out = new BufferImpl(total);
    let offset = 0;
    for (const b of list) {
      out.set(b.subarray(0, Math.max(0, total - offset)), offset);
      offset += b.length;
      if (offset >= total) break;
    }
    return out;
  },
  isBuffer(value: unknown): value is BufferImpl {
    return value instanceof Uint8Array;
  },
  byteLength(value: string | Uint8Array, encoding?: Encoding): number {
    return typeof value === 'string' ? fromString(value, encoding).length : value.length;
  },
  compare,
};

/** The constructor as learner code and the runtime see it: our statics, constructing our instances. */
export interface BufferConstructor extends Omit<typeof statics, never> {
  new (length: number): BufferImpl;
  new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): BufferImpl;
  readonly prototype: BufferImpl;
}

export const MiniBuffer: BufferConstructor = Object.assign(BufferImpl, statics);
export type Bytes = BufferImpl;

/** The platform's Buffer: Node's where it exists (`yarn verify`), otherwise this one, installed for the learner's code too. */
interface BufferGlobal {
  Buffer?: unknown;
}
const scope: BufferGlobal = globalThis;
if (scope.Buffer === undefined) scope.Buffer = MiniBuffer;

// Node's Buffer is a superset of this one; the runtime only relies on the subset declared here.
export const Buffer = scope.Buffer as BufferConstructor;
