/**
 * 解析 + 全量验证 .trailshare（v2026.4 · 旅程化）。
 *
 * 验证顺序：
 *  0 版本闸门   只认 ts-2026.4；旧版本直接抛 OldShareVersionError
 *  1 结构校验   groups[].payload.places[].photos[]
 *  2 验签       整包签名，覆盖所有组
 *  3 承诺       「可见 place 的 (placeId, tag, intensity) 有序列表」+ 每组盐
 *  4 链锚       能查则查，查不到不算失败
 *  5 解封       逐组试 wrappedKeys；解不开的组整组消失
 *
 * 一组都解不开 → 抛 "此信物不包含给你的内容"。
 */
import { verifyCanonical } from '../crypto/sign';
import { verifyGroupPlacesCommitment, type GroupPlacesCommitmentInput } from '../crypto/commitment';
import { decryptBytes, importAesKey, unwrapKey } from '../crypto/encrypt';
import { x25519KeyPairFromSeed, type Identity } from '../crypto/keys';
import { hasHash, GENESIS_HASH } from '../crypto/chain';
import { hexToBytes } from '@noble/hashes/utils';
import { isShareVersion, versionMinor, SHARE_VERSION, MAX_GROUPS, MAX_PHOTOS } from './schema';
import type {
  ChainRecord,
  IntensityBucket,
  PlaceMeta,
  SharePackage,
  SignedBody,
  Tag,
  VerificationReport,
} from '../types';

/** 旧版本信物：解析时直接抛错，让 UI 能给出明确提示。 */
export class OldShareVersionError extends Error {
  readonly version: string;

  constructor(version: string) {
    super('此信物为旧版本，请让发送方重新生成');
    this.name = 'OldShareVersionError';
    this.version = version;
  }
}

export interface UnpackContext {
  chainEnabled?: boolean;
  knownChain?: ChainRecord[];
  /** 接收方 X25519 私钥（hex）。不传会退回本机身份，见 resolveX25519Priv */
  x25519Priv?: string;
  /** @deprecated v2026.4 起解密靠 X25519，口令不参与；保留仅为兼容旧调用 */
  passphrase?: string;
}

export type UnpackCredential = UnpackContext | Identity;

export interface UnpackedPhoto {
  photoId: string;
  data: Uint8Array;
  caption?: string;
}

export interface UnpackedPlace {
  placeId: string;
  tag: Tag;
  intensity: IntensityBucket;
  name: string;
  label?: string;
  date: string;
  photos: UnpackedPhoto[];
}

/** 一个成功解开的组。未授权 / 解不开的组不会出现在这里。 */
export interface UnpackedGroup {
  groupId: string;
  /** 按日期升序 */
  places: UnpackedPlace[];
}

export interface UnpackResult {
  pkg: SharePackage | null;
  report: VerificationReport;
  /** 只包含"解开了"的组；顺序与包里一致 */
  groups: UnpackedGroup[];
  /** v2026.4 不再需要口令，恒为 false；保留字段避免旧调用炸掉 */
  needsPassphrase: boolean;
  canAccept: boolean;
}

const TAG_SET = new Set(['heritage', 'nature', 'watertown', 'metropolis', 'food', 'leisure']);
const INTENSITY_SET = new Set(['low', 'mid', 'high']);

const CURRENT_MINOR = versionMinor(SHARE_VERSION) ?? 0;

function emptyReport(errors: string[]): VerificationReport {
  return {
    structureOk: false,
    signatureOk: false,
    commitmentOk: null,
    chainOk: null,
    chainNote: '未检查',
    errors,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validatePlaceMeta(meta: unknown, errors: string[], label: string): PlaceMeta | null {
  if (!isRecord(meta)) {
    errors.push(`${label} 的 meta 缺失或格式错误`);
    return null;
  }
  const local: string[] = [];
  if (typeof meta.name !== 'string' || meta.name.trim().length === 0) local.push(`${label} 缺少地点名`);
  if (typeof meta.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) {
    local.push(`${label} 的 date 不是 YYYY-MM-DD`);
  }
  if (meta.label !== undefined && typeof meta.label !== 'string') local.push(`${label} 的 label 格式错误`);
  if (local.length > 0) {
    errors.push(...local);
    return null;
  }
  const out: PlaceMeta = { name: meta.name as string, date: meta.date as string };
  if (typeof meta.label === 'string' && meta.label.length > 0) out.label = meta.label;
  return out;
}

function validatePlace(place: unknown, index: number, errors: string[]): boolean {
  const label = `places[${index}]`;
  if (!isRecord(place)) {
    errors.push(`${label} 不是一个对象`);
    return false;
  }
  if (typeof place.placeId !== 'string' || place.placeId.length === 0) errors.push(`${label}.placeId 缺失`);
  if (typeof place.tag !== 'string' || !TAG_SET.has(place.tag)) {
    errors.push(`${label}.tag 非法：${String(place.tag)}`);
  }
  if (typeof place.intensity !== 'string' || !INTENSITY_SET.has(place.intensity)) {
    errors.push(`${label}.intensity 非法：${String(place.intensity)}`);
  }
  if (typeof place.ivMeta !== 'string') errors.push(`${label}.ivMeta 缺失`);
  if (typeof place.encryptedMeta !== 'string') errors.push(`${label}.encryptedMeta 缺失`);

  if (!Array.isArray(place.photos) || place.photos.length === 0) {
    errors.push(`${label}.photos 不能为空`);
  } else {
    if (place.photos.length > MAX_PHOTOS) errors.push(`${label} 照片数超过 ${MAX_PHOTOS}`);
    place.photos.forEach((photo, i) => {
      if (
        !isRecord(photo) ||
        typeof photo.photoId !== 'string' ||
        typeof photo.encrypted !== 'string' ||
        typeof photo.iv !== 'string'
      ) {
        errors.push(`${label}.photos[${i}] 缺少 photoId/encrypted/iv`);
        return;
      }
      const hasCaption = photo.encryptedCaption !== undefined || photo.ivCaption !== undefined;
      if (hasCaption && (typeof photo.encryptedCaption !== 'string' || typeof photo.ivCaption !== 'string')) {
        errors.push(`${label}.photos[${i}] 的配文密文不完整`);
      }
    });
  }
  return true;
}

function validateGroup(group: unknown, index: number, errors: string[]): boolean {
  const label = `groups[${index}]`;
  if (!isRecord(group)) {
    errors.push(`${label} 不是一个对象`);
    return false;
  }
  if (typeof group.groupId !== 'string' || group.groupId.length === 0) errors.push(`${label}.groupId 缺失`);

  if (!isRecord(group.payload)) {
    errors.push(`${label}.payload 缺失`);
    return false;
  }
  const payload = group.payload;
  if (payload.cipher !== 'aes-gcm') errors.push(`${label}.payload.cipher 必须是 aes-gcm`);
  if (typeof payload.salt !== 'string') errors.push(`${label}.payload.salt 缺失`);
  if (!Array.isArray(payload.places) || payload.places.length === 0) {
    errors.push(`${label}.payload.places 不能为空`);
  } else {
    payload.places.forEach((place, i) => validatePlace(place, i, errors));
  }

  if (!Array.isArray(group.wrappedKeys) || group.wrappedKeys.length === 0) {
    errors.push(`${label}.wrappedKeys 不能为空`);
  } else {
    group.wrappedKeys.forEach((k, i) => {
      if (
        !isRecord(k) ||
        typeof k.recipientPubkey !== 'string' ||
        typeof k.ephemeralPubkey !== 'string' ||
        typeof k.encryptedKey !== 'string' ||
        typeof k.iv !== 'string'
      ) {
        errors.push(`${label}.wrappedKeys[${i}] 字段不完整`);
      }
    });
  }
  return true;
}

export function validateStructure(obj: unknown, errors: string[]): SharePackage | null {
  if (!isRecord(obj)) {
    errors.push('文件不是一个 JSON 对象');
    return null;
  }
  if (typeof obj.version !== 'string') {
    errors.push('缺少协议版本');
  } else if (!isShareVersion(obj.version)) {
    const minor = versionMinor(obj.version);
    errors.push(
      minor !== null && minor > CURRENT_MINOR
        ? `此信物由更新版本生成（${obj.version}），请升级本应用后再打开`
        : `不支持的协议版本：${obj.version}`,
    );
  }
  if (typeof obj.shareId !== 'string' || obj.shareId.length === 0) errors.push('缺少 shareId');
  if (!isRecord(obj.from)) {
    errors.push('缺少 from 段');
  } else {
    if (typeof obj.from.pubkey !== 'string' || !obj.from.pubkey.startsWith('ed25519:')) {
      errors.push('from.pubkey 格式错误');
    }
    if (typeof obj.from.sig !== 'string' || !obj.from.sig.startsWith('ed25519:')) {
      errors.push('from.sig 格式错误');
    }
    if (typeof obj.from.displayName !== 'string' || obj.from.displayName.length === 0) {
      errors.push('缺少发件人显示名');
    }
  }

  if (!Array.isArray(obj.groups) || obj.groups.length === 0) {
    errors.push('groups 不能为空');
  } else if (obj.groups.length > MAX_GROUPS) {
    errors.push(`组数超过上限 ${MAX_GROUPS}`);
  } else {
    obj.groups.forEach((g, i) => validateGroup(g, i, errors));
  }

  if (!isRecord(obj.commitment)) {
    errors.push('缺少 commitment 段');
  } else if (typeof obj.commitment.hash !== 'string') {
    errors.push('commitment.hash 缺失');
  }
  if (!isRecord(obj.chain)) {
    errors.push('缺少 chain 段');
  } else if (typeof obj.chain.prevHash !== 'string' || typeof obj.chain.seq !== 'number') {
    errors.push('chain.prevHash / chain.seq 格式错误');
  }
  if (typeof obj.createdAt !== 'string') errors.push('缺少 createdAt');

  if (errors.length > 0) return null;
  return obj as unknown as SharePackage;
}

function bodyOf(pkg: SharePackage): SignedBody {
  return {
    version: pkg.version,
    shareId: pkg.shareId,
    from: { displayName: pkg.from.displayName, pubkey: pkg.from.pubkey },
    groups: pkg.groups,
    commitment: pkg.commitment,
    chain: pkg.chain,
    createdAt: pkg.createdAt,
  };
}

function commitmentInputsOf(pkg: SharePackage): GroupPlacesCommitmentInput[] {
  return pkg.groups.map((g) => ({
    groupId: g.groupId,
    saltB64: g.payload.salt,
    places: g.payload.places.map((p) => ({ placeId: p.placeId, tag: p.tag, intensity: p.intensity })),
  }));
}

function isIdentity(cred: UnpackCredential): cred is Identity {
  const c = cred as Identity;
  return typeof c.x25519Priv === 'string' && typeof c.pubkey === 'string';
}

/** 拿"我的 X25519 私钥"：显式传入优先，否则退回本机身份。 */
async function resolveX25519Priv(cred: UnpackCredential | undefined): Promise<string> {
  if (cred && isIdentity(cred)) return cred.x25519Priv;
  const ctx = (cred ?? {}) as UnpackContext;
  if (typeof ctx.x25519Priv === 'string' && ctx.x25519Priv.length > 0) return ctx.x25519Priv;

  try {
    const { ensureKeyPair } = await import('../store/keys');
    const kp = await ensureKeyPair(new Date());
    return x25519KeyPairFromSeed(kp.privHex).x25519Priv;
  } catch {
    throw new Error('缺少解密密钥：找不到可用的本机身份');
  }
}

export async function unpack(
  input: string | SharePackage,
  cred?: UnpackCredential,
): Promise<UnpackResult> {
  const ctx: UnpackContext = cred
    ? isIdentity(cred)
      ? { chainEnabled: true, knownChain: [], x25519Priv: cred.x25519Priv }
      : cred
    : { chainEnabled: true, knownChain: [] };

  const errors: string[] = [];
  let parsed: unknown;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return {
        pkg: null,
        report: emptyReport(['文件不是合法 JSON，可能已损坏']),
        groups: [],
        needsPassphrase: false,
        canAccept: false,
      };
    }
  } else {
    parsed = input;
  }

  // 版本闸门：旧版本没有 places[]，继续解析只会得到一堆无意义的字段错误
  if (isRecord(parsed) && typeof parsed.version === 'string') {
    const minor = versionMinor(parsed.version);
    if (minor !== null && minor < CURRENT_MINOR) {
      throw new OldShareVersionError(parsed.version);
    }
  }

  const pkg = validateStructure(parsed, errors);
  if (!pkg) {
    return {
      pkg: null,
      report: emptyReport(errors),
      groups: [],
      needsPassphrase: false,
      canAccept: false,
    };
  }

  const report: VerificationReport = {
    structureOk: true,
    signatureOk: false,
    commitmentOk: null,
    chainOk: null,
    chainNote: '',
    errors,
  };

  /* ---- 2 验签 ---- */
  try {
    report.signatureOk = await verifyCanonical(bodyOf(pkg), pkg.from.sig, pkg.from.pubkey);
  } catch {
    report.signatureOk = false;
  }
  if (!report.signatureOk) {
    report.errors.push('签名无效：文件被篡改，或并非声称的发件人所签');
  }

  /* ---- 3 承诺（只看公开字段，不需要密钥） ---- */
  report.commitmentOk = verifyGroupPlacesCommitment(pkg.commitment.hash, commitmentInputsOf(pkg));
  if (!report.commitmentOk) {
    report.errors.push('承诺与公开的地点语义不一致：地点信息可能被替换');
  }

  /* ---- 4 链锚 ---- */
  const chainEnabled = ctx.chainEnabled !== false;
  const knownChain = ctx.knownChain ?? [];
  if (!chainEnabled) {
    report.chainOk = null;
    report.chainNote = '链锚定已关闭（chain_enabled=false），未做链校验';
  } else if (pkg.chain.seq === 0 && pkg.chain.prevHash === GENESIS_HASH) {
    report.chainOk = true;
    report.chainNote = '创世锚点：seq=0 且 prevHash 为全零，包内自洽（第三方时间证明需 OTS L1）';
  } else if (hasHash(knownChain, pkg.chain.prevHash)) {
    report.chainOk = true;
    report.chainNote = `前序锚点 ${pkg.chain.prevHash.slice(0, 12)}… 存在于本地账本，信物是连续插入的`;
  } else {
    report.chainOk = null;
    report.chainNote = `前序锚点 ${pkg.chain.prevHash.slice(0, 12)}… 不在本地账本（跨设备属预期）；仅能确认包内 seq/prevHash 已被签名覆盖`;
  }

  /* ---- 5 逐组解封：解不开的整组消失 ---- */
  const x25519PrivHex = await resolveX25519Priv(cred);
  const xPriv = hexToBytes(x25519PrivHex);
  const opened: UnpackedGroup[] = [];

  for (const group of pkg.groups) {
    let groupKey: Uint8Array | null = null;
    for (const wrapped of group.wrappedKeys) {
      try {
        groupKey = await unwrapKey(wrapped, xPriv);
        break;
      } catch {
        // 不是给我的；全部失败则该组不出现
      }
    }
    if (!groupKey) continue;

    try {
      const aes = await importAesKey(groupKey);
      const places: UnpackedPlace[] = [];

      for (const encryptedPlace of group.payload.places) {
        try {
          const metaBytes = await decryptBytes(aes, {
            ivB64: encryptedPlace.ivMeta,
            dataB64: encryptedPlace.encryptedMeta,
          });
          const meta = validatePlaceMeta(
            JSON.parse(new TextDecoder().decode(metaBytes)),
            report.errors,
            `组 ${group.groupId} 的 ${encryptedPlace.placeId}`,
          );
          if (!meta) continue;

          const photos: UnpackedPhoto[] = [];
          for (const p of encryptedPlace.photos) {
            const data = await decryptBytes(aes, { ivB64: p.iv, dataB64: p.encrypted });
            const photo: UnpackedPhoto = { photoId: p.photoId, data };
            if (p.encryptedCaption && p.ivCaption) {
              const captionBytes = await decryptBytes(aes, {
                ivB64: p.ivCaption,
                dataB64: p.encryptedCaption,
              });
              photo.caption = new TextDecoder().decode(captionBytes);
            }
            photos.push(photo);
          }

          places.push({
            placeId: encryptedPlace.placeId,
            tag: encryptedPlace.tag,
            intensity: encryptedPlace.intensity,
            name: meta.name,
            ...(meta.label ? { label: meta.label } : {}),
            date: meta.date,
            photos,
          });
        } catch {
          report.errors.push(`地点 ${encryptedPlace.placeId} 解密失败，已丢弃`);
        }
      }

      if (places.length === 0) continue;
      places.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
      opened.push({ groupId: group.groupId, places });
    } catch {
      report.errors.push(`组 ${group.groupId} 解密失败，已丢弃`);
    }
  }

  if (opened.length === 0) {
    throw new Error('此信物不包含给你的内容');
  }

  const canAccept =
    report.structureOk && report.signatureOk && report.commitmentOk !== false && opened.length > 0;

  return { pkg, report, groups: opened, needsPassphrase: false, canAccept };
}

/* ------------------------------------------------------------------ *
 * 视图层接口
 *
 * 只回"解开的组 + 发件人"，不返回 pkg —— UI 因此拿不到"一共有几组"。
 * 错误折成 { ok:false, kind, reason }，结构错误原文（含 groups[0]）不透传。
 * ------------------------------------------------------------------ */

export interface UnpackedGroupView {
  groupId: string;
  places: UnpackedPlace[];
  fromName: string;
  fromPubkey: string;
  shareId: string;
  /** 这一组是否已经接受或拒绝过（由 UI 查本地边后回填） */
  processed: boolean;
}

export interface SafeReport {
  structureOk: boolean;
  signatureOk: boolean;
  commitmentOk: boolean | null;
  chainOk: boolean | null;
  chainNote: string;
}

export interface UnpackView {
  ok: true;
  groups: UnpackedGroupView[];
  from: { displayName: string; pubkey: string };
  shareId: string;
  commitment: string;
  signature: string;
  chainSeq: number;
  chainPrevHash: string;
  chainOk: boolean | null;
  chainNote: string;
  report: SafeReport;
  canAccept: boolean;
}

export interface UnpackFailure {
  ok: false;
  kind: 'old-version' | 'not-for-you' | 'invalid';
  reason: string;
}

export type UnpackViewResult = UnpackView | UnpackFailure;

export async function unpackForViewer(
  input: string | SharePackage,
  ctx: UnpackContext = {},
): Promise<UnpackViewResult> {
  let res: UnpackResult;
  try {
    res = await unpack(input, ctx);
  } catch (err) {
    if (err instanceof OldShareVersionError) {
      return { ok: false, kind: 'old-version', reason: err.message };
    }
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('不包含给你的内容')) {
      return { ok: false, kind: 'not-for-you', reason: '此信物不包含给你的内容' };
    }
    return { ok: false, kind: 'invalid', reason: '文件已损坏，或不是 TrailShare 信物' };
  }

  const pkg = res.pkg;
  if (!pkg) {
    return { ok: false, kind: 'invalid', reason: '文件已损坏，或不是 TrailShare 信物' };
  }

  const safeReport: SafeReport = {
    structureOk: res.report.structureOk,
    signatureOk: res.report.signatureOk,
    commitmentOk: res.report.commitmentOk,
    chainOk: res.report.chainOk,
    chainNote: res.report.chainNote,
  };

  return {
    ok: true,
    groups: res.groups.map((g) => ({
      groupId: g.groupId,
      places: g.places,
      fromName: pkg.from.displayName,
      fromPubkey: pkg.from.pubkey,
      shareId: pkg.shareId,
      processed: false,
    })),
    from: { displayName: pkg.from.displayName, pubkey: pkg.from.pubkey },
    shareId: pkg.shareId,
    commitment: pkg.commitment.hash,
    signature: pkg.from.sig,
    chainSeq: pkg.chain.seq,
    chainPrevHash: pkg.chain.prevHash,
    chainOk: res.report.chainOk,
    chainNote: res.report.chainNote,
    report: safeReport,
    canAccept: res.report.structureOk && res.report.signatureOk && res.report.commitmentOk !== false,
  };
}
