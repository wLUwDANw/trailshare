import { describe, expect, it } from 'vitest';
import { pack, serializePackage, packageFileName } from '../src/share/pack';
import { unpack, OldShareVersionError } from '../src/share/unpack';
import { generateIdentityFromSeed } from '../src/crypto/keys';
import { applyVisibility } from '../src/utils/filter';
import type { Trip, TripPhoto, VisibilityState } from '../src/types';

const A = generateIdentityFromSeed('a1'.repeat(32));
const B = generateIdentityFromSeed('b2'.repeat(32));

function photo(n: number, caption?: string): TripPhoto {
  return {
    id: `ph_${n}`,
    image: new Uint8Array([n, n + 1, n + 2, n + 3]).buffer,
    ...(caption ? { caption } : {}),
  };
}

function baseTrip(): Trip {
  return {
    id: 't1',
    title: '洛阳三日',
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
            photos: [photo(1, '人好多但值得'), photo(2)],
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
            label: '下午',
            tag: 'nature',
            intensity: 'high',
            coverIndex: 0,
            photos: [photo(3, '云海'), photo(4), photo(5)],
          },
        ],
      },
      {
        id: 'd3',
        date: '2026-10-03',
        places: [
          { id: 'p3', name: '洛邑古城', tag: 'heritage', intensity: 'mid', coverIndex: 0, photos: [photo(6)] },
        ],
      },
    ],
  };
}

function vis(partial: Partial<VisibilityState> = {}): VisibilityState {
  return {
    id: 't1::g1',
    tripId: 't1',
    groupId: 'g1',
    hiddenDayIds: [],
    hiddenPlaceIds: [],
    hiddenPhotoIds: [],
    hiddenCaptionPhotoIds: [],
    ...partial,
  };
}

async function packOne(trip: Trip, visibility: VisibilityState, recipients = [B.pubkey]) {
  return pack({
    groups: [{ trip, visibility, recipientPubkeys: recipients }],
    senderIdentity: A,
    displayName: 'A',
    now: new Date('2026-10-10T00:00:00.000Z'),
  });
}

describe('pack / unpack v2026.4', () => {
  it('单组单地点：往返后内容完整', async () => {
    const trip = baseTrip();
    trip.days = [trip.days[0]];
    const { pkg } = await packOne(trip, vis());
    const res = await unpack(pkg, B);

    expect(pkg.version).toBe('ts-2026.4');
    expect(res.groups.length).toBe(1);
    const place = res.groups[0].places[0];
    expect(place.name).toBe('龙门石窟');
    expect(place.label).toBe('上午');
    expect(place.date).toBe('2026-10-01');
    expect(place.tag).toBe('heritage');
    expect(place.intensity).toBe('high');
    expect(place.photos.length).toBe(2);
    expect(Array.from(place.photos[0].data)).toEqual([1, 2, 3, 4]);
    expect(place.photos[0].caption).toBe('人好多但值得');
    expect(place.photos[1].caption).toBeUndefined();
  });

  it('同一地点的多张照片保持顺序，配文逐张对应', async () => {
    const trip = baseTrip();
    trip.days = [trip.days[1]];
    const { pkg } = await packOne(trip, vis());
    const res = await unpack(pkg, B);
    const photos = res.groups[0].places[0].photos;
    expect(photos.map((p) => p.photoId)).toEqual(['ph_3', 'ph_4', 'ph_5']);
    expect(photos[0].caption).toBe('云海');
    expect(photos[1].caption).toBeUndefined();
  });

  it('同一天多个地点：date 相同，顺序与旅程一致', async () => {
    const trip = baseTrip();
    trip.days[0].places.push({
      id: 'p1b',
      name: '洛邑古城',
      tag: 'watertown',
      intensity: 'mid',
      coverIndex: 0,
      photos: [photo(9)],
    });
    const { pkg } = await packOne(trip, vis());
    const res = await unpack(pkg, B);
    const sameDay = res.groups[0].places.filter((p) => p.date === '2026-10-01');
    expect(sameDay.map((p) => p.placeId)).toEqual(['p1', 'p1b']);
  });

  it('日期乱序时按日期升序返回', async () => {
    const trip = baseTrip();
    trip.days.reverse();
    const { pkg } = await packOne(trip, vis());
    const res = await unpack(pkg, B);
    expect(res.groups[0].places.map((p) => p.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('多组：每组只含自己的可见地点', async () => {
    const trip = baseTrip();
    const { pkg } = await pack({
      groups: [
        { trip, visibility: vis({ hiddenDayIds: ['d2', 'd3'] }), recipientPubkeys: [B.pubkey] },
        { trip, visibility: vis({ groupId: 'g2' }), recipientPubkeys: [B.pubkey] },
      ],
      senderIdentity: A,
    });
    expect(pkg.groups.length).toBe(2);
    expect(pkg.groups[0].payload.places.length).toBe(1);
    expect(pkg.groups[1].payload.places.length).toBe(3);
    const res = await unpack(pkg, B);
    expect(res.groups.length).toBe(2);
    expect(res.groups[0].places.length).toBe(1);
    expect(res.groups[1].places.length).toBe(3);
  });

  it('屏蔽一整天 → 包结构里没有这一天的任何地点', async () => {
    const trip = baseTrip();
    const { pkg } = await packOne(trip, vis({ hiddenDayIds: ['d2'] }));
    const ids = pkg.groups[0].payload.places.map((p) => p.placeId);
    expect(ids).toEqual(['p1', 'p3']);
    expect(ids).not.toContain('p2');
  });

  it('屏蔽一个地点 → 只有它消失', async () => {
    const trip = baseTrip();
    const { pkg } = await packOne(trip, vis({ hiddenPlaceIds: ['p2'] }));
    expect(pkg.groups[0].payload.places.map((p) => p.placeId)).toEqual(['p1', 'p3']);
  });

  it('屏蔽一张照片 → 该照片不在包内，其余仍在', async () => {
    const trip = baseTrip();
    const { pkg } = await packOne(trip, vis({ hiddenPhotoIds: ['ph_1'] }));
    const photos = pkg.groups[0].payload.places[0].photos;
    expect(photos.map((p) => p.photoId)).toEqual(['ph_2']);
  });

  it('屏蔽配文 → 照片在包里，但 encryptedCaption 不存在', async () => {
    const trip = baseTrip();
    const { pkg } = await packOne(trip, vis({ hiddenCaptionPhotoIds: ['ph_1'] }));
    const first = pkg.groups[0].payload.places[0].photos[0];
    expect(first.photoId).toBe('ph_1');
    expect(first.encryptedCaption).toBeUndefined();
    expect(first.ivCaption).toBeUndefined();
  });

  it('一个地点的照片全被屏蔽 → 这个地点不打包；整组为空则抛错', async () => {
    const trip = baseTrip();
    trip.days = [trip.days[2]];
    await expect(packOne(trip, vis({ hiddenPhotoIds: ['ph_6'] }))).rejects.toThrow(/没有任何可见内容/);
  });

  it('没有可见内容 → 抛错', async () => {
    await expect(packOne(baseTrip(), vis({ hiddenDayIds: ['d1', 'd2', 'd3'] }))).rejects.toThrow(
      /没有任何可见内容/,
    );
  });

  it('接收方为空 → 抛错', async () => {
    await expect(packOne(baseTrip(), vis(), [])).rejects.toThrow(/至少要选 1 个接收方/);
  });

  it('超过 3 组 → 抛错', async () => {
    const trip = baseTrip();
    await expect(
      pack({
        groups: [1, 2, 3, 4].map((i) => ({
          trip,
          visibility: vis({ groupId: `g${i}` }),
          recipientPubkeys: [B.pubkey],
        })),
        senderIdentity: A,
      }),
    ).rejects.toThrow(/最多 3 组/);
  });

  it('一个地点超过 5 张照片 → 抛错', async () => {
    const trip = baseTrip();
    trip.days[0].places[0].photos = [1, 2, 3, 4, 5, 6].map((n) => photo(n));
    await expect(packOne(trip, vis())).rejects.toThrow(/最多 5 张/);
  });

  it('每张照片有独立的 IV 与密文', async () => {
    const { pkg } = await packOne(baseTrip(), vis());
    const photos = pkg.groups[0].payload.places[0].photos;
    expect(photos[0].iv).not.toBe(photos[1].iv);
    expect(photos[0].encrypted).not.toBe(photos[1].encrypted);
  });

  it('多接收方：每人一条 wrappedKey，临时公钥互不相同', async () => {
    const { pkg } = await packOne(baseTrip(), vis(), [A.pubkey, B.pubkey]);
    const keys = pkg.groups[0].wrappedKeys;
    expect(keys.length).toBe(2);
    expect(keys[0].ephemeralPubkey).not.toBe(keys[1].ephemeralPubkey);
  });

  it('承诺覆盖可见 place 的 tag：改 tag → 承诺校验失败', async () => {
    const { pkg } = await packOne(baseTrip(), vis());
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.groups[0].payload.places[0].tag = 'food';
    const res = await unpack(tampered, B);
    expect(res.report.commitmentOk).toBe(false);
    expect(res.canAccept).toBe(false);
  });

  it('承诺覆盖 placeId：改 placeId → 承诺失败', async () => {
    const { pkg } = await packOne(baseTrip(), vis());
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.groups[0].payload.places[1].placeId = 'p_hacked';
    const res = await unpack(tampered, B);
    expect(res.report.commitmentOk).toBe(false);
  });

  it('改密文 → 验签失败', async () => {
    const { pkg } = await packOne(baseTrip(), vis());
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.groups[0].payload.places[0].photos[0].encrypted = 'AAAA';
    const res = await unpack(tampered, B);
    expect(res.report.signatureOk).toBe(false);
  });

  it('链关闭：不写链记录，seq=0', async () => {
    const { pkg, chainRecord } = await pack({
      groups: [{ trip: baseTrip(), visibility: vis(), recipientPubkeys: [B.pubkey] }],
      senderIdentity: A,
      chainEnabled: false,
    });
    expect(chainRecord).toBeNull();
    expect(pkg.chain.seq).toBe(0);
    const res = await unpack(pkg, { chainEnabled: false, knownChain: [], x25519Priv: B.x25519Priv });
    expect(res.report.chainOk).toBeNull();
  });

  it('filter 结果与实际打包一致', async () => {
    const trip = baseTrip();
    const visibility = vis({ hiddenDayIds: ['d1'] });
    const filtered = applyVisibility(trip, visibility);
    const { pkg } = await packOne(trip, visibility);
    expect(pkg.groups[0].payload.places.length).toBe(filtered.visiblePlaces.length);
    expect(pkg.groups[0].payload.places.map((p) => p.placeId)).toEqual(
      filtered.visiblePlaces.map((v) => v.place.id),
    );
  });

  it('serialize / packageFileName 可用', async () => {
    const { pkg } = await packOne(baseTrip(), vis());
    const text = serializePackage(pkg);
    expect(JSON.parse(text).shareId).toBe(pkg.shareId);
    expect(packageFileName(pkg)).toBe(`${pkg.shareId}.trailshare`);
  });

  it('v2026.3 旧信物被拒绝', async () => {
    const legacy = { version: 'ts-2026.3', shareId: 's_old' };
    await expect(unpack(legacy as never, B)).rejects.toBeInstanceOf(OldShareVersionError);
    await expect(unpack(legacy as never, B)).rejects.toThrow('此信物为旧版本，请让发送方重新生成');
  });
});
