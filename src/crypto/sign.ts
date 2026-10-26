/**
 * 签名 / 验签。对外只收发可序列化数据（Uint8Array、string）。
 *
 * 签名格式统一为 `ed25519:<hex>`，即使算法只有一个，也保留前缀，
 * 方便将来加算法时旧包仍然可解析。
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { asBufferSource, concatBytes } from '../utils/binary';
import { detectEd25519Impl, seedToPkcs8, normalizePubkey } from './keys';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(concatBytes(...m));

export const SIG_PREFIX = 'ed25519:';

export function utf8(text: string): Uint8Array {
  return utf8ToBytes(text);
}

/**
 * 规范化 JSON：递归按 key 字典序输出，保证「同样的对象 → 同样的字节」。
 * 签名覆盖的是规范化后的字节，而不是对象，这样才能跨序列化实现一致。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export async function sign(message: Uint8Array, privHex: string): Promise<string> {
  const impl = await detectEd25519Impl();
  if (impl === 'webcrypto') {
    try {
      const key = await crypto.subtle.importKey(
        'pkcs8',
        asBufferSource(seedToPkcs8(privHex)),
        { name: 'Ed25519' },
        false,
        ['sign'],
      );
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, asBufferSource(message));
      return SIG_PREFIX + bytesToHex(new Uint8Array(sig));
    } catch {
      // 某些实现即使 importKey 成功，sign 仍可能不支持；落到 noble
    }
  }
  const sig = ed.sign(message, hexToBytes(privHex));
  return SIG_PREFIX + bytesToHex(sig);
}

export async function verify(
  message: Uint8Array,
  signature: string,
  pubkey: string,
): Promise<boolean> {
  const sigHex = signature.startsWith(SIG_PREFIX) ? signature.slice(SIG_PREFIX.length) : signature;
  const pubHex = normalizePubkey(pubkey);
  let sig: Uint8Array;
  try {
    sig = hexToBytes(sigHex);
  } catch {
    return false;
  }
  if (sig.byteLength !== 64) return false;

  const impl = await detectEd25519Impl();
  if (impl === 'webcrypto') {
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        asBufferSource(hexToBytes(pubHex)),
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, asBufferSource(sig), asBufferSource(message));
    } catch {
      // 落到 noble
    }
  }
  try {
    return ed.verify(sig, message, hexToBytes(pubHex));
  } catch {
    return false;
  }
}

export function signCanonical(obj: unknown, privHex: string): Promise<string> {
  return sign(utf8(canonicalJson(obj)), privHex);
}

export function verifyCanonical(
  obj: unknown,
  signature: string,
  pubkey: string,
): Promise<boolean> {
  return verify(utf8(canonicalJson(obj)), signature, pubkey);
}
