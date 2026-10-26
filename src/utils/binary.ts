/**
 * 二进制存储转换。
 *
 * 为什么要这层：WebKit（Safari）IndexedDB 存 Uint8Array 时，读回可能是 ArrayBuffer，
 * 某些 inline-key 场景会直接抛错。统一策略是：写 ArrayBuffer，读后转 Uint8Array。
 */

export function toStorage(buf: Uint8Array): ArrayBuffer {
  // slice 保证拿到独立的 ArrayBuffer，不会把整个底层 buffer 带进数据库
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function fromStorage(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * WebCrypto 的 DOM 类型（TS 5.7+）要求 ArrayBufferView<ArrayBuffer>，
 * 而 Uint8Array 的类型参数是 ArrayBufferLike，直接传会报类型错。
 * 统一在这里收口，避免每个调用点写 as unknown as。
 */
export function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}
