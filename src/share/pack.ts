/**
 * 生成 .trailshare（v2026.4 · 旅程化）。
 *
 * 一组 = 一段旅程的"可见切片"：
 *   1 调 applyVisibility() 过滤（屏蔽 = 不打包）
 *   2 没有可见 place → 抛错
 *   3 每组一把 32 字节组密钥
 *   4 每个 place：加密 meta（name/label/date）+ 逐张加密照片（+ 可选配文）
 *   5 KEM 把组密钥分别包给每个接收方
 *   6 承诺覆盖「可见 place 的 (placeId, tag, intensity) 有序列表」+ 每组盐
 *   7 签名 + 打包
 *
 * tag / intensity 是明文：承诺必须能被不持钥的人验证，这是 v2026.3 就定下的取舍。
 */
import { groupPlacesCommitmentValue, type GroupPlacesCommitmentInput } from '../crypto/commitment';
import {
  encryptBytes,
  encryptText,
  importAesKey,
  randomBytes,
  randomKeyBytes,
  wrapKeyForRecipients,
} from '../crypto/encrypt';
import { signCanonical } from '../crypto/sign';
import { chainHash, GENESIS_HASH } from '../crypto/chain';
import { hexToBytes } from '@noble/hashes/utils';
import { bytesToBase64 } from '../utils/base64';
import { applyVisibility, type FilterResult } from '../utils/filter';
import { MAX_GROUPS, MAX_PHOTOS, SHARE_VERSION } from './schema';
import { uuid } from '../utils/id';
import type { Identity } from '../crypto/keys';
import type {
  ChainRecord,
  EncryptedPhoto,
  EncryptedPlace,
  PlaceMeta,
  ShareGroup,
  SharePackage,
  SignedBody,
  Trip,
  VisibilityState,
} from '../types';

export interface PackGroupInput {
  trip: Trip;
  /** 这一组的屏蔽状态（每个 group 独立） */
  visibility: VisibilityState;
  /** 这一组给谁看（Ed25519 公钥，带不带前缀都行） */
  recipientPubkeys: string[];
}

export interface PackInput {
  groups: PackGroupInput[];
  senderIdentity: Identity;
  displayName?: string;
  /** 本地链的最后一条；null 表示这是本设备第一条 */
  prevChain?: ChainRecord | null;
  chainEnabled?: boolean;
  now?: Date;
  shareId?: string;
}

export interface PackResult {
  pkg: SharePackage;
  /** 与 groups 同序的可见内容（调用方写本地记忆 / 预览时用） */
  visible: FilterResult[];
  chainRecord: ChainRecord | null;
}

function assertGroup(group: PackGroupInput, index: number): FilterResult {
  const label = `第 ${index + 1} 组`;
  if (!group || !group.trip) throw new Error(`${label}缺少旅程`);
  if (!Array.isArray(group.recipientPubkeys) || group.recipientPubkeys.length === 0) {
    throw new Error(`${label}至少要选 1 个接收方`);
  }

  const filtered = applyVisibility(group.trip, group.visibility);
  if (filtered.visiblePlaces.length === 0) {
    throw new Error(`${label}没有任何可见内容`);
  }

  for (const item of filtered.visiblePlaces) {
    if (item.visiblePhotos.length === 0) {
      throw new Error(`${label}的「${item.place.name || '未命名地点'}」没有可见照片`);
    }
    if (item.visiblePhotos.length > MAX_PHOTOS) {
      throw new Error(`${label}的地点最多 ${MAX_PHOTOS} 张照片（当前 ${item.visiblePhotos.length} 张）`);
    }
    for (const vp of item.visiblePhotos) {
      if (!(vp.photo.image instanceof ArrayBuffer) || vp.photo.image.byteLength === 0) {
        throw new Error(`${label}有照片数据为空`);
      }
    }
  }
  return filtered;
}

export async function pack(input: PackInput): Promise<PackResult> {
  if (!Array.isArray(input.groups) || input.groups.length === 0) {
    throw new Error('至少要有一组内容');
  }
  if (input.groups.length > MAX_GROUPS) {
    throw new Error(`最多 ${MAX_GROUPS} 组（当前 ${input.groups.length} 组）`);
  }
  const sender = input.senderIdentity;
  if (!sender || typeof sender.privHex !== 'string' || typeof sender.x25519Priv !== 'string') {
    throw new Error('缺少发送方身份');
  }

  const now = input.now ?? new Date();
  const shareId = input.shareId ?? `s_${uuid().slice(0, 8)}`;
  const senderX25519Priv = hexToBytes(sender.x25519Priv);

  const groups: ShareGroup[] = [];
  const visible: FilterResult[] = [];
  const commitmentInputs: GroupPlacesCommitmentInput[] = [];

  for (let i = 0; i < input.groups.length; i += 1) {
    const g = input.groups[i];
    const filtered = assertGroup(g, i);

    const saltB64 = bytesToBase64(randomBytes(16));
    const keyBytes = randomKeyBytes();
    const aes = await importAesKey(keyBytes);

    const places: EncryptedPlace[] = [];
    for (const item of filtered.visiblePlaces) {
      const meta: PlaceMeta = {
        name: item.place.name.trim() || '未命名地点',
        date: item.dayDate,
        ...(item.place.label?.trim() ? { label: item.place.label.trim() } : {}),
      };
      const metaCipher = await encryptText(aes, JSON.stringify(meta));

      const photos: EncryptedPhoto[] = [];
      for (const vp of item.visiblePhotos) {
        const cipher = await encryptBytes(aes, new Uint8Array(vp.photo.image));
        const photo: EncryptedPhoto = {
          photoId: vp.photo.id,
          encrypted: cipher.dataB64,
          iv: cipher.ivB64,
        };
        if (vp.includeCaption && vp.photo.caption) {
          const captionCipher = await encryptText(aes, vp.photo.caption);
          photo.encryptedCaption = captionCipher.dataB64;
          photo.ivCaption = captionCipher.ivB64;
        }
        photos.push(photo);
      }

      places.push({
        placeId: item.place.id,
        tag: item.place.tag,
        intensity: item.place.intensity,
        ivMeta: metaCipher.ivB64,
        encryptedMeta: metaCipher.dataB64,
        photos,
      });
    }

    const wrappedKeys = await wrapKeyForRecipients(keyBytes, g.recipientPubkeys, senderX25519Priv);
    const groupId = `g${i + 1}_${uuid().slice(0, 6)}`;

    groups.push({
      groupId,
      payload: { cipher: 'aes-gcm', salt: saltB64, places },
      wrappedKeys,
    });

    visible.push(filtered);
    commitmentInputs.push({
      groupId,
      saltB64,
      places: places.map((p) => ({ placeId: p.placeId, tag: p.tag, intensity: p.intensity })),
    });
  }

  const commitment = groupPlacesCommitmentValue(commitmentInputs);

  const prevHash =
    input.chainEnabled === false ? GENESIS_HASH : (input.prevChain?.hash ?? GENESIS_HASH);
  const seq = input.chainEnabled === false ? 0 : input.prevChain ? input.prevChain.seq + 1 : 0;

  const body: SignedBody = {
    version: SHARE_VERSION,
    shareId,
    from: { displayName: input.displayName?.trim() || '我', pubkey: `ed25519:${sender.pubHex}` },
    groups,
    commitment: { hash: commitment, algo: 'sha256' },
    chain: { prevHash, seq, anchor: null },
    createdAt: now.toISOString(),
  };

  const sig = await signCanonical(body, sender.privHex);
  const pkg: SharePackage = { ...body, from: { ...body.from, sig } };

  const chainRecord: ChainRecord | null =
    input.chainEnabled === false
      ? null
      : {
          seq,
          prevHash,
          hash: chainHash(shareId, sig, prevHash, seq),
          event: 'share_created',
          refId: shareId,
          ts: body.createdAt,
        };

  return { pkg, visible, chainRecord };
}

/** 语义别名：多组场景下读起来更清楚（与 pack 完全等价）。 */
export const packMultiGroup = pack;

export function serializePackage(pkg: SharePackage): string {
  return JSON.stringify(pkg, null, 2);
}

export function packageFileName(pkg: SharePackage): string {
  return `${pkg.shareId}.trailshare`;
}
