/**
 * Ed25519 密钥对：生成、导出、由种子推导公钥。
 *
 * 实现策略（见方案 4.2）：
 * - 签名/验签优先走 WebCrypto 原生 Ed25519（Chrome 137+ / Safari 17+ / Firefox 129+）。
 * - 旧浏览器自动降级 @noble/ed25519（纯 JS）。
 * - 两条路径共用同一套"32 字节种子"表示，所以密钥可以跨实现互操作。
 *
 * 注意：本项目把私钥种子以 hex 存 IndexedDB，仅为赛事演示便利；
 * 生产环境应改用不可导出的 WebCrypto CryptoKey 或加密存储（README 已标注）。
 */
import * as ed from '@noble/ed25519';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { asBufferSource, concatBytes } from '../utils/binary';

// @noble/ed25519 v2 的同步接口需要外部注入 sha512
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(concatBytes(...m));

export type Ed25519Impl = 'webcrypto' | 'noble';

/** Ed25519 私钥的 PKCS#8 前缀（RFC 8410），后接 32 字节种子。 */
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export interface GeneratedKeyPair {
  privHex: string;
  pubHex: string;
}

let cachedImpl: Ed25519Impl | null = null;
let probing: Promise<Ed25519Impl> | null = null;

export async function detectEd25519Impl(): Promise<Ed25519Impl> {
  if (cachedImpl) return cachedImpl;
  if (probing) return probing;
  probing = (async () => {
    try {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle) throw new Error('no subtle');
      const seed = new Uint8Array(32).fill(7);
      const key = await subtle.importKey(
        'pkcs8',
        asBufferSource(concatBytes(PKCS8_PREFIX, seed)),
        { name: 'Ed25519' },
        false,
        ['sign'],
      );
      await subtle.sign({ name: 'Ed25519' }, key, new Uint8Array([1, 2, 3]));
      cachedImpl = 'webcrypto';
    } catch {
      cachedImpl = 'noble';
    }
    return cachedImpl;
  })();
  return probing;
}

/** 仅供测试重置探测缓存。 */
export function __resetImplCache(): void {
  cachedImpl = null;
  probing = null;
}

export function randomSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('当前环境缺少安全随机源，无法生成密钥');
  }
  c.getRandomValues(seed);
  return seed;
}

export function publicKeyFromSeed(privHex: string): string {
  const seed = hexToBytes(privHex);
  if (seed.byteLength !== 32) throw new Error(`私钥长度非法：${seed.byteLength} 字节`);
  return bytesToHex(ed.getPublicKey(seed));
}

export function generateKeyPair(): GeneratedKeyPair {
  const seed = randomSeed();
  const privHex = bytesToHex(seed);
  return { privHex, pubHex: publicKeyFromSeed(privHex) };
}

/** 把 32 字节种子包装成 PKCS#8 DER，供 WebCrypto 导入。 */
export function seedToPkcs8(privHex: string): Uint8Array {
  return concatBytes(PKCS8_PREFIX, hexToBytes(privHex));
}

export function normalizePubkey(pubkey: string): string {
  return pubkey.startsWith('ed25519:') ? pubkey.slice('ed25519:'.length) : pubkey;
}

export function fingerprint(pubkey: string, len = 8): string {
  return normalizePubkey(pubkey).slice(0, len);
}

/* ------------------------------------------------------------------ *
 * X25519（KEM 用）：从同一份 Ed25519 种子派生，不需要迁移旧用户
 * ------------------------------------------------------------------ */

/** 一份完整身份：签名用的 Ed25519 + 收信用的 X25519，都从同一个种子来。 */
export interface Identity {
  /** Ed25519 公钥，带 ed25519: 前缀（与分享包里的写法一致） */
  pubkey: string;
  /** 裸 hex，便于放进各种结构 */
  pubHex: string;
  /** Ed25519 种子 hex（签名用） */
  privHex: string;
  /** X25519 私钥 hex（解封信用） */
  x25519Priv: string;
  /** X25519 公钥 hex（别人给你写信时用） */
  x25519Pub: string;
}

/**
 * Ed25519 种子 → X25519 密钥对。
 *
 * 用的是 RFC 7748 的标准转换：clamp(SHA512(seed)[0..32])。
 * @noble/curves 的 toMontgomerySecret 就是这个算法，所以老用户的种子不用换，
 * X25519 密钥每次都能从种子里重新算出来。
 */
export function x25519KeyPairFromSeed(privHex: string): {
  x25519Priv: string;
  x25519Pub: string;
} {
  const seed = hexToBytes(normalizePubkey(privHex));
  if (seed.byteLength !== 32) throw new Error(`种子长度非法：${seed.byteLength} 字节`);
  const xPriv = ed25519.utils.toMontgomerySecret(seed);
  const xPub = x25519.getPublicKey(xPriv);
  return { x25519Priv: bytesToHex(xPriv), x25519Pub: bytesToHex(xPub) };
}

/** Ed25519 公钥 → X25519 公钥（给发送方用：只知道对方公钥也能加密）。 */
export function ed25519ToX25519Pub(pubHex: string): string {
  const raw = normalizePubkey(pubHex);
  const bytes = hexToBytes(raw);
  if (bytes.byteLength !== 32) throw new Error(`公钥长度非法：${bytes.byteLength} 字节`);
  return bytesToHex(ed25519.utils.toMontgomery(bytes));
}

export function generateIdentityFromSeed(privHex: string): Identity {
  const pubHex = publicKeyFromSeed(privHex);
  const { x25519Priv, x25519Pub } = x25519KeyPairFromSeed(privHex);
  return {
    pubkey: `ed25519:${pubHex}`,
    pubHex,
    privHex,
    x25519Priv,
    x25519Pub,
  };
}

export function generateIdentity(): Identity {
  return generateIdentityFromSeed(generateKeyPair().privHex);
}
