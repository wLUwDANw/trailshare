import { describe, expect, it } from 'vitest';
import {
  generateKeyPair,
  publicKeyFromSeed,
  detectEd25519Impl,
} from '../src/crypto/keys';
import { canonicalJson, sign, verify, signCanonical } from '../src/crypto/sign';
import { commitmentHex, verifyCommitment, commitmentInput } from '../src/crypto/commitment';
import { appendChain, chainHash, verifyChainLink, GENESIS_HASH, verifyRecordHash } from '../src/crypto/chain';
import { deriveKey, encryptBytes, decryptBytes, encryptText, decryptText } from '../src/crypto/encrypt';
import { bytesToBase64, base64ToBytes } from '../src/utils/base64';
import { bytesEqual, toStorage, fromStorage } from '../src/utils/binary';
import { decay, daysBetween } from '../src/utils/time';
import { trust, trustStats } from '../src/utils/trust';
import type { ChainRecord, ProvenanceEdge } from '../src/types';

describe('keys', () => {
  it('生成 32 字节种子与 32 字节公钥', () => {
    const kp = generateKeyPair();
    expect(kp.privHex).toHaveLength(64);
    expect(kp.pubHex).toHaveLength(64);
  });

  it('同一私钥永远推出同一公钥', () => {
    const kp = generateKeyPair();
    expect(publicKeyFromSeed(kp.privHex)).toBe(kp.pubHex);
  });

  it('两次生成不同', () => {
    expect(generateKeyPair().privHex).not.toBe(generateKeyPair().privHex);
  });

  it('能在当前环境探测出实现', async () => {
    const impl = await detectEd25519Impl();
    expect(['webcrypto', 'noble']).toContain(impl);
  });
});

describe('sign / verify', () => {
  it('签名可通过验证', async () => {
    const { privHex, pubHex } = generateKeyPair();
    const msg = new TextEncoder().encode('旅迹信物');
    const sig = await sign(msg, privHex);
    expect(sig.startsWith('ed25519:')).toBe(true);
    expect(await verify(msg, sig, pubHex)).toBe(true);
    expect(await verify(msg, sig, `ed25519:${pubHex}`)).toBe(true);
  });

  it('改一个字节就验签失败', async () => {
    const { privHex, pubHex } = generateKeyPair();
    const msg = new TextEncoder().encode('hello');
    const sig = await sign(msg, privHex);
    expect(await verify(new TextEncoder().encode('hellp'), sig, pubHex)).toBe(false);
  });

  it('换一把公钥验签失败', async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const sig = await sign(new TextEncoder().encode('x'), a.privHex);
    expect(await verify(new TextEncoder().encode('x'), sig, b.pubHex)).toBe(false);
  });

  it('畸形签名不抛错，直接返回 false', async () => {
    const { pubHex } = generateKeyPair();
    expect(await verify(new Uint8Array([1]), 'ed25519:zzzz', pubHex)).toBe(false);
    expect(await verify(new Uint8Array([1]), 'ed25519:00', pubHex)).toBe(false);
  });

  it('规范化 JSON 与 key 顺序无关', async () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });

  it('对对象签名等价于对规范化 JSON 签名', async () => {
    const { privHex, pubHex } = generateKeyPair();
    const obj = { z: [1, 2, { y: true, x: null }], a: '中文' };
    const sig = await signCanonical(obj, privHex);
    expect(await verify(new TextEncoder().encode(canonicalJson(obj)), sig, pubHex)).toBe(true);
  });
});

describe('base64 / binary', () => {
  it('base64 往返', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    expect(bytesEqual(base64ToBytes(bytesToBase64(bytes)), bytes)).toBe(true);
  });

  it('toStorage 返回独立的 ArrayBuffer 切片', () => {
    const big = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = big.subarray(2, 5);
    const buf = toStorage(view);
    expect(buf.byteLength).toBe(3);
    expect(Array.from(new Uint8Array(buf))).toEqual([1, 2, 3]);
    expect(fromStorage(buf).byteLength).toBe(3);
  });
});

describe('commitment', () => {
  it('相同输入得到相同承诺', () => {
    expect(commitmentHex('nature', 'c2FsdA==', 'high')).toBe(
      commitmentHex('nature', 'c2FsdA==', 'high'),
    );
  });

  it('改强度就换承诺（强度进承诺但不可反推）', () => {
    expect(commitmentHex('nature', 'c2FsdA==', 'high')).not.toBe(
      commitmentHex('nature', 'c2FsdA==', 'mid'),
    );
  });

  it('盐不同则承诺不同', () => {
    expect(commitmentHex('nature', 'aa==', 'high')).not.toBe(
      commitmentHex('nature', 'bb==', 'high'),
    );
  });

  it('分隔符避免拼接歧义', () => {
    // 故意构造一个非法标签，验证拼接不会把 ('nature','ab') 与 ('naturea','b') 混为一谈
    expect(commitmentInput('nature', 'ab', 'high')).not.toBe(
      commitmentInput('naturea' as unknown as Parameters<typeof commitmentInput>[0], 'b', 'high'),
    );
  });

  it('verifyCommitment 接受带前缀与不带前缀', () => {
    const value = `sha256:${commitmentHex('food', 'c2FsdA==', 'low')}`;
    expect(verifyCommitment(value, 'food', 'c2FsdA==', 'low')).toBe(true);
    expect(verifyCommitment(value, 'food', 'c2FsdA==', 'high')).toBe(false);
  });
});

describe('chain', () => {
  const mk = (i: number): ChainRecord => ({
    seq: i,
    prevHash: i === 0 ? GENESIS_HASH : `h${i - 1}`,
    hash: `h${i}`,
    event: 'share_created',
    refId: `s${i}`,
    ts: '2026-10-18T00:00:00.000Z',
  });

  it('首条记录指向创世哈希', () => {
    const rec = appendChain(null, 'share_created', 's1', 'ed25519:aa', '2026-10-18T00:00:00Z');
    expect(rec.seq).toBe(0);
    expect(rec.prevHash).toBe(GENESIS_HASH);
    expect(rec.hash).toHaveLength(64);
  });

  it('seq 递增且 prevHash 串联', () => {
    const first = appendChain(null, 'share_created', 's1', 'sig1', '2026-10-18T00:00:00Z');
    const second = appendChain(first, 'share_accepted', 's2', 'sig2', '2026-10-18T00:00:01Z');
    expect(second.seq).toBe(1);
    expect(second.prevHash).toBe(first.hash);
  });

  it('相同输入 hash 相同，改 sig 就变', () => {
    expect(chainHash('s1', 'sig', GENESIS_HASH, 0)).toBe(chainHash('s1', 'sig', GENESIS_HASH, 0));
    expect(chainHash('s1', 'sig', GENESIS_HASH, 0)).not.toBe(chainHash('s1', 'sig2', GENESIS_HASH, 0));
  });

  it('连续链校验通过', () => {
    const a = mk(0);
    const b = { ...mk(1), prevHash: a.hash };
    expect(verifyChainLink([a, b]).ok).toBe(true);
  });

  it('断链能被发现', () => {
    const a = mk(0);
    const broken = { ...mk(1), prevHash: 'wrong' };
    const result = verifyChainLink([a, broken]);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('乱序传入也能正确校验', () => {
    const a = mk(0);
    const b = { ...mk(1), prevHash: a.hash };
    expect(verifyChainLink([b, a]).ok).toBe(true);
  });

  it('verifyRecordHash 能复算记录 hash', () => {
    const rec = appendChain(null, 'share_created', 's9', 'ed25519:abc', '2026-10-18T00:00:00Z');
    expect(verifyRecordHash(rec, 'ed25519:abc')).toBe(true);
    expect(verifyRecordHash(rec, 'ed25519:abd')).toBe(false);
  });
});

describe('encrypt', () => {
  it('AES-GCM 往返', async () => {
    const { key } = await deriveKey('woaini123');
    const plain = new TextEncoder().encode('老君山');
    const cipher = await encryptBytes(key, plain);
    expect(base64ToBytes(cipher.dataB64)).not.toEqual(plain);
    expect(await decryptBytes(key, cipher)).toEqual(plain);
  });

  it('同一口令 + 同一盐派生同一密钥', async () => {
    const a = await deriveKey('pw');
    const b = await deriveKey('pw', a.saltB64);
    const cipher = await encryptText(a.key, 'x');
    expect(await decryptText(b.key, cipher)).toBe('x');
  });

  it('口令错误解不开（GCM 完整性校验）', async () => {
    const a = await deriveKey('right');
    const cipher = await encryptText(a.key, 'secret');
    const wrong = await deriveKey('wrong', a.saltB64);
    await expect(decryptText(wrong.key, cipher)).rejects.toBeTruthy();
  });

  it('篡改密文会失败而不是返回垃圾', async () => {
    const { key } = await deriveKey('pw');
    const cipher = await encryptText(key, 'hello world');
    const bytes = base64ToBytes(cipher.dataB64);
    bytes[0] ^= 0xff;
    await expect(
      decryptText(key, { ivB64: cipher.ivB64, dataB64: bytesToBase64(bytes) }),
    ).rejects.toBeTruthy();
  });

  it('空口令走默认口令，与显式默认值等价', async () => {
    const a = await deriveKey('');
    const b = await deriveKey('trailshare-default-2026', a.saltB64);
    const cipher = await encryptText(a.key, 'same');
    expect(await decryptText(b.key, cipher)).toBe('same');
  });
});

describe('time / trust', () => {
  it('每过一个半衰期衰减一半', () => {
    expect(decay(0, 90)).toBe(1);
    expect(decay(90, 90)).toBeCloseTo(0.5, 6);
    expect(decay(180, 90)).toBeCloseTo(0.25, 6);
  });

  it('未来时间不产生 >1 的权重', () => {
    expect(decay(-10, 90)).toBe(1);
  });

  it('daysBetween 按天计', () => {
    expect(daysBetween(new Date('2026-10-18T00:00:00Z'), new Date('2026-10-20T00:00:00Z'))).toBe(2);
  });

  it('新朋友信任为 0，分母加 1 防除零', () => {
    expect(trust('nobody', [])).toBe(0);
  });

  it('接受与拒绝都影响信任', () => {
    const edges = [
      { fromPubkey: 'A', rejected: false },
      { fromPubkey: 'A', rejected: false },
      { fromPubkey: 'A', rejected: true },
    ] as ProvenanceEdge[];
    expect(trustStats('A', edges).accepted).toBe(2);
    expect(trustStats('A', edges).rejected).toBe(1);
    expect(trust('A', edges)).toBeCloseTo(2 / 4, 6);
  });
});
