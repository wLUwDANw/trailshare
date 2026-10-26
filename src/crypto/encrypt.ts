/**
 * AES-GCM 加密 + PBKDF2 密钥派生（WebCrypto）。
 *
 * 语义：
 * - PBKDF2 把弱口令拉成 32 字节强密钥，加随机盐避免彩虹表。
 * - AES-GCM 自带完整性校验：改一个字节就解不开，不需要额外 MAC。
 *
 * 边界：本文件允许调用 crypto.subtle；对外只暴露 Uint8Array / string。
 */
import { bytesToBase64, base64ToBytes } from '../utils/base64';
import { concatBytes } from '../utils/binary';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { x25519 } from '@noble/curves/ed25519.js';
import { ed25519ToX25519Pub, normalizePubkey } from './keys';
import type { WrappedKey } from '../types';

export const KDF_ITERATIONS = 100_000;
export const DEFAULT_PASSPHRASE = 'trailshare-default-2026'; // 用户不填口令时的保底值

export interface DerivedKey {
  key: CryptoKey;
  saltB64: string;
}

export interface CipherText {
  ivB64: string;
  dataB64: string;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('当前环境不支持 WebCrypto，无法加解密');
  return s;
}

export function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('当前环境缺少安全随机源');
  }
  c.getRandomValues(buf);
  return buf;
}

export function effectivePassphrase(passphrase?: string): string {
  const p = (passphrase ?? '').trim();
  return p.length > 0 ? p : DEFAULT_PASSPHRASE;
}

export async function deriveKey(passphrase: string, saltB64?: string): Promise<DerivedKey> {
  const salt = saltB64 ? base64ToBytes(saltB64) : randomBytes(16);
  const baseKey = await subtle().importKey(
    'raw',
    new TextEncoder().encode(effectivePassphrase(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await subtle().deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: KDF_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { key, saltB64: bytesToBase64(salt) };
}

export async function encryptBytes(key: CryptoKey, plain: Uint8Array): Promise<CipherText> {
  const iv = randomBytes(12);
  const data = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    plain as unknown as BufferSource,
  );
  return {
    ivB64: bytesToBase64(iv),
    dataB64: bytesToBase64(new Uint8Array(data)),
  };
}

export async function decryptBytes(
  key: CryptoKey,
  cipher: CipherText,
): Promise<Uint8Array> {
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(cipher.ivB64) as unknown as BufferSource },
    key,
    base64ToBytes(cipher.dataB64) as unknown as BufferSource,
  );
  return new Uint8Array(plain);
}

export async function encryptText(key: CryptoKey, text: string): Promise<CipherText> {
  return encryptBytes(key, new TextEncoder().encode(text));
}

export async function decryptText(key: CryptoKey, cipher: CipherText): Promise<string> {
  return new TextDecoder().decode(await decryptBytes(key, cipher));
}

/* ------------------------------------------------------------------ *
 * KEM/DEM 信封加密（MD-3）
 *
 * 思路：
 *   1. 每组随机生成一把 32 字节"组密钥"（DEM 的钥匙）
 *   2. 对每个接收方，用 X25519 临时密钥做一次 ECDH，把组密钥单独包一份（KEM）
 *   3. 组密钥只用来加密照片和 meta；包密钥本身用 AES-GCM 再包一层
 *
 * 为什么用临时密钥：每次包装都换一把，静态私钥不直接参与加密，
 * 事后即使接收方私钥泄露，也解不开历史文件（前向安全的方向）。
 * ------------------------------------------------------------------ */

const KEM_INFO = new TextEncoder().encode('trailshare-kem-v1');
export const KEM_KEY_BYTES = 32;

/** 生成一把随机的组密钥（DEM 用）。 */
export function randomKeyBytes(): Uint8Array {
  return randomBytes(KEM_KEY_BYTES);
}

/** 把裸字节导入成 AES-GCM 的 CryptoKey。 */
export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey(
    'raw',
    raw as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** ECDH 出来的共享秘密 → 32 字节 AES 密钥。盐固定为 sha256(ePub || 接收方 X 公钥)。 */
function deriveKemKey(shared: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, salt, KEM_INFO, KEM_KEY_BYTES);
}

/**
 * 把组密钥分别包给每个接收方。每个接收方一条记录、一把独立的临时密钥。
 *
 * 注：签名里的 senderX25519Priv 目前只做长度校验，不参与 KDF——
 * 因为 unwrapKey 只拿得到自己的私钥，拿不到发送方的公钥，任何用到发送方私钥的
 * 派生都无法被对方复现。真正保证"只有对方能解"的是临时 ECDH。
 * 这个参数留给后续的认证 KEM（把发送方静态密钥混进 HKDF）。
 *
 * 返回 Promise 是因为 AES-GCM 走 WebCrypto（异步）；KEM 那半是同步的。
 */
export async function wrapKeyForRecipients(
  symmetricKey: Uint8Array,
  recipientPubkeys: string[],
  senderX25519Priv: Uint8Array,
): Promise<WrappedKey[]> {
  if (!(symmetricKey instanceof Uint8Array) || symmetricKey.byteLength !== KEM_KEY_BYTES) {
    throw new Error(`组密钥必须是 ${KEM_KEY_BYTES} 字节`);
  }
  if (!Array.isArray(recipientPubkeys) || recipientPubkeys.length === 0) {
    throw new Error('至少需要一个接收方');
  }
  if (!(senderX25519Priv instanceof Uint8Array) || senderX25519Priv.byteLength !== 32) {
    throw new Error('发送方 X25519 私钥长度非法');
  }

  const out: WrappedKey[] = [];
  for (const raw of recipientPubkeys) {
    const recipientPubkey = normalizePubkey(raw);
    if (recipientPubkey.length !== 64) throw new Error(`接收方公钥非法：${raw}`);
    const recipientX = hexToBytes(ed25519ToX25519Pub(recipientPubkey));

    const ephPriv = x25519.utils.randomSecretKey();
    const ephPub = x25519.getPublicKey(ephPriv);
    const shared = x25519.getSharedSecret(ephPriv, recipientX);

    const key = deriveKemKey(shared, sha256(concatBytes(ephPub, recipientX)));
    const cipher = await encryptBytes(await importAesKey(key), symmetricKey);

    out.push({
      recipientPubkey,
      ephemeralPubkey: bytesToHex(ephPub),
      encryptedKey: cipher.dataB64,
      iv: cipher.ivB64,
    });
  }
  return out;
}

/**
 * 尝试用我的 X25519 私钥解开某一条 wrappedKey。
 * 不是给我的、或者数据被改过，一律抛 "not-a-recipient"（不区分原因，避免探测）。
 */
export async function unwrapKey(
  wrapped: WrappedKey,
  myX25519Priv: Uint8Array,
): Promise<Uint8Array> {
  if (
    !wrapped ||
    typeof wrapped.ephemeralPubkey !== 'string' ||
    typeof wrapped.encryptedKey !== 'string' ||
    typeof wrapped.iv !== 'string'
  ) {
    throw new Error('not-a-recipient');
  }
  if (!(myX25519Priv instanceof Uint8Array) || myX25519Priv.byteLength !== 32) {
    throw new Error('not-a-recipient');
  }

  let ephPub: Uint8Array;
  try {
    ephPub = hexToBytes(wrapped.ephemeralPubkey);
  } catch {
    throw new Error('not-a-recipient');
  }
  if (ephPub.byteLength !== 32) throw new Error('not-a-recipient');

  const myPub = x25519.getPublicKey(myX25519Priv);
  const shared = x25519.getSharedSecret(myX25519Priv, ephPub);
  const key = deriveKemKey(shared, sha256(concatBytes(ephPub, myPub)));

  try {
    const plain = await decryptBytes(await importAesKey(key), {
      ivB64: wrapped.iv,
      dataB64: wrapped.encryptedKey,
    });
    if (plain.byteLength !== KEM_KEY_BYTES) throw new Error('bad-key-length');
    return plain;
  } catch {
    throw new Error('not-a-recipient');
  }
}
