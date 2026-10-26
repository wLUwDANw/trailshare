import { describe, expect, it } from 'vitest';
import { pack } from '../src/share/pack';
import { unpack, unpackForViewer, OldShareVersionError } from '../src/share/unpack';
import { generateIdentityFromSeed } from '../src/crypto/keys';
import { unwrapKey } from '../src/crypto/encrypt';
import { hexToBytes } from '@noble/hashes/utils';
import type { Trip, VisibilityState } from '../src/types';

const A = generateIdentityFromSeed('a1'.repeat(32));
const B = generateIdentityFromSeed('b2'.repeat(32));
const C = generateIdentityFromSeed('c3'.repeat(32));
const D = generateIdentityFromSeed('d4'.repeat(32));

function trip(): Trip {
  return {
    id: 't1',
    title: '测试旅程',
    createdAt: '2026-10-01T00:00:00.000Z',
    days: [
      {
        id: 'd1',
        date: '2026-10-01',
        places: [
          {
            id: 'p1',
            name: '龙门石窟',
            label: '上午',
            tag: 'heritage',
            intensity: 'high',
            coverIndex: 0,
            photos: [{ id: 'ph1', image: new Uint8Array([1, 2, 3, 4]).buffer }],
          },
        ],
      },
      {
        id: 'd2',
        date: '2026-10-02',
        places: [
          {
            id: 'p2',
            name: '老君山',
            tag: 'nature',
            intensity: 'mid',
            coverIndex: 0,
            photos: [{ id: 'ph2', image: new Uint8Array([5, 6, 7, 8]).buffer }],
          },
        ],
      },
    ],
  };
}

function vis(groupId = 'g1', hiddenDayIds: string[] = []): VisibilityState {
  return {
    id: `t1::${groupId}`,
    tripId: 't1',
    groupId,
    hiddenDayIds,
    hiddenPlaceIds: [],
    hiddenPhotoIds: [],
    hiddenCaptionPhotoIds: [],
  };
}

const toArray = (b: Uint8Array) => Array.from(b);

describe('定向加密 · 单组', () => {
  it('单组单接收方：能解开，内容完整', async () => {
    const { pkg } = await pack({
      groups: [{ trip: trip(), visibility: vis(), recipientPubkeys: [B.pubkey] }],
      senderIdentity: A,
    });
    const res = await unpack(pkg, B);
    expect(res.groups.length).toBe(1);
    expect(res.groups[0].places[0].name).toBe('龙门石窟');
    expect(toArray(res.groups[0].places[0].photos[0].data)).toEqual([1, 2, 3, 4]);
  });

  it('单组多接收方：都能解开', async () => {
    const { pkg } = await pack({
      groups: [{ trip: trip(), visibility: vis(), recipientPubkeys: [B.pubkey, C.pubkey] }],
      senderIdentity: A,
    });
    expect((await unpack(pkg, B)).groups.length).toBe(1);
    expect((await unpack(pkg, C)).groups.length).toBe(1);
  });

  it('未授权用户：抛「不包含给你的内容」', async () => {
    const { pkg } = await pack({
      groups: [{ trip: trip(), visibility: vis(), recipientPubkeys: [B.pubkey] }],
      senderIdentity: A,
    });
    await expect(unpack(pkg, D)).rejects.toThrow('此信物不包含给你的内容');
  });

  it('两个接收方的包装用不同临时密钥', async () => {
    const { pkg } = await pack({
      groups: [{ trip: trip(), visibility: vis(), recipientPubkeys: [B.pubkey, C.pubkey] }],
      senderIdentity: A,
    });
    const keys = pkg.groups[0].wrappedKeys;
    expect(keys[0].ephemeralPubkey).not.toBe(keys[1].ephemeralPubkey);
  });
});

describe('定向加密 · 多组与篡改', () => {
  it('多组并行：B 只能解组 1，C 只能解组 2', async () => {
    const { pkg } = await pack({
      groups: [
        { trip: trip(), visibility: vis('g1', ['d2']), recipientPubkeys: [B.pubkey] },
        { trip: trip(), visibility: vis('g2', ['d1']), recipientPubkeys: [C.pubkey] },
      ],
      senderIdentity: A,
    });

    const forB = await unpack(pkg, B);
    expect(forB.groups.length).toBe(1);
    expect(forB.groups[0].places.map((p) => p.placeId)).toEqual(['p1']);

    const forC = await unpack(pkg, C);
    expect(forC.groups.length).toBe(1);
    expect(forC.groups[0].places.map((p) => p.placeId)).toEqual(['p2']);
  });

  it('改任意一组的 tag → 承诺校验失败', async () => {
    const { pkg } = await pack({
      groups: [{ trip: trip(), visibility: vis(), recipientPubkeys: [B.pubkey] }],
      senderIdentity: A,
    });
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.groups[0].payload.places[0].tag = 'food';

    const res = await unpack(tampered, B);
    expect(res.report.commitmentOk).toBe(false);
    expect(res.report.signatureOk).toBe(false);
    expect(res.canAccept).toBe(false);
  });

  it('改 wrappedKeys 一个字节 → 这一组解不开，整体抛错', async () => {
    const { pkg } = await pack({
      groups: [{ trip: trip(), visibility: vis(), recipientPubkeys: [B.pubkey] }],
      senderIdentity: A,
    });
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.groups[0].wrappedKeys[0].encryptedKey = 'AAAA';

    await expect(unpack(tampered, B)).rejects.toThrow('此信物不包含给你的内容');
    await expect(
      unwrapKey(tampered.groups[0].wrappedKeys[0], hexToBytes(B.x25519Priv)),
    ).rejects.toThrow('not-a-recipient');
  });

  it('链关闭时功能完整', async () => {
    const { pkg, chainRecord } = await pack({
      groups: [{ trip: trip(), visibility: vis(), recipientPubkeys: [B.pubkey] }],
      senderIdentity: A,
      chainEnabled: false,
    });
    expect(chainRecord).toBeNull();
    expect(pkg.chain.seq).toBe(0);
    const res = await unpack(pkg, { chainEnabled: false, knownChain: [], x25519Priv: B.x25519Priv });
    expect(res.report.chainOk).toBeNull();
    expect(res.groups[0].places.length).toBe(2);
  });

  it('v2026.3 旧版本被拒绝', async () => {
    const legacy = {
      version: 'ts-2026.3',
      shareId: 's_old',
      from: { displayName: 'A', pubkey: A.pubkey, sig: 'ed25519:00' },
      groups: [],
      commitment: { hash: 'sha256:00', algo: 'sha256' },
      chain: { prevHash: '0'.repeat(64), seq: 0, anchor: null },
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    await expect(unpack(legacy as never, B)).rejects.toBeInstanceOf(OldShareVersionError);
  });
});

describe('视图层不暴露组数（收尾要求）', () => {
  it('授权用户只拿到自己能解开的组，结果里没有 totalGroups', async () => {
    const { pkg } = await pack({
      groups: [
        { trip: trip(), visibility: vis('g1', ['d2']), recipientPubkeys: [B.pubkey] },
        { trip: trip(), visibility: vis('g2', ['d1']), recipientPubkeys: [C.pubkey] },
      ],
      senderIdentity: A,
    });
    const view = await unpackForViewer(pkg, B);
    expect(view.ok).toBe(true);
    if (!view.ok) return;

    expect(view.groups.length).toBe(1);
    expect(view.groups[0].places[0].tag).toBe('heritage');
    expect(view.groups[0].fromName).toBe('我');
    expect(view.groups[0].shareId).toBe(pkg.shareId);
    expect(view.groups[0].processed).toBe(false);
    expect('totalGroups' in view).toBe(false);
    expect('pkg' in view).toBe(false);
  });

  it('未授权用户的 reason 不含组数信息', async () => {
    const { pkg } = await pack({
      groups: [{ trip: trip(), visibility: vis(), recipientPubkeys: [B.pubkey] }],
      senderIdentity: A,
    });
    const view = await unpackForViewer(pkg, D);
    expect(view.ok).toBe(false);
    if (view.ok) return;
    expect(view.kind).toBe('not-for-you');
    expect(view.reason).not.toMatch(/组|group|total|\d/i);
  });

  it('两组都给同一个人时返回两组，但没有任何总数线索', async () => {
    const { pkg } = await pack({
      groups: [
        { trip: trip(), visibility: vis('g1', ['d2']), recipientPubkeys: [B.pubkey] },
        { trip: trip(), visibility: vis('g2', ['d1']), recipientPubkeys: [B.pubkey] },
      ],
      senderIdentity: A,
    });
    const view = await unpackForViewer(pkg, B);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.groups.length).toBe(2);
    expect(Object.keys(view)).not.toContain('totalGroups');
    expect(Object.keys(view)).not.toContain('pkg');
  });
});
