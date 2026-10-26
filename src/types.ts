/**
 * TrailShare 全部类型定义。
 *
 * 设计约束（见技术方案 3.2 / 20）：
 * - 所有类型必须可 JSON 序列化（ArrayBuffer / string / number / boolean / 数组 / 普通对象）。
 * - 纯函数层（agent/*、crypto/commitment.ts、crypto/chain.ts、utils/time.ts、utils/trust.ts）
 *   只依赖本文件，不依赖 DOM / IndexedDB / crypto.subtle。
 */

/* ------------------------------------------------------------------ *
 * 语义标签
 * ------------------------------------------------------------------ */

/** 六类粗粒度语义标签。类别越细越容易被反推出具体地点，所以只保留六类。 */
export type Tag =
  | 'heritage' // 人文历史
  | 'nature' // 自然风光
  | 'watertown' // 水乡古镇
  | 'metropolis' // 都市风光
  | 'food' // 美食探索
  | 'leisure'; // 休闲度假

export const ALL_TAGS: readonly Tag[] = [
  'heritage',
  'nature',
  'watertown',
  'metropolis',
  'food',
  'leisure',
] as const;

export const TAG_LABELS: Record<Tag, string> = {
  heritage: '人文历史',
  nature: '自然风光',
  watertown: '水乡古镇',
  metropolis: '都市风光',
  food: '美食探索',
  leisure: '休闲度假',
};

/** 强度只分三档。精确分数会泄露"你有多喜欢"。 */
export type IntensityBucket = 'low' | 'mid' | 'high';

/** 三档分享粒度，构成"隐私–可验证"坐标轴。 */
export type Granularity = 'plain' | 'encrypted' | 'commitment_only';

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  plain: '明文',
  encrypted: '加密',
  commitment_only: '仅承诺',
};

/** ★ 强度展示：三档对应一/二/三颗星。存储层仍是 low/mid/high，一个字节都没变。 */
export const INTENSITY_STARS: Record<IntensityBucket, string> = {
  low: '★',
  mid: '★★',
  high: '★★★',
};

/** 星星下方的人话标注。 */
export const INTENSITY_MEANING: Record<IntensityBucket, string> = {
  low: '一般',
  mid: '喜欢',
  high: '强烈推荐',
};

/* ------------------------------------------------------------------ *
 * 数据模型（IndexedDB）
 * ------------------------------------------------------------------ */

export interface Memory {
  id: string; // uuid v4
  kind: 'self' | 'gift';
  /**
   * 组内所有照片（压缩后的字节）。
   *
   * 新写入的记录一定带这个字段。类型上设为可选，是因为 src/experiments/fixtures.ts
   * 构造 Memory 时只有旧的 thumbBlob，而那个文件在本次改动中不允许修改；
   * 运行时一律通过 store/memories.ts 的 photosOf() / coverOf() 归一化，
   * 缺字段的旧记录会被当成"只有一张照片"处理。
   */
  photos?: ArrayBuffer[];
  /** 封面索引（指向 photos）。越界由 coverOf() 兜底到 0。新记录必填。 */
  coverIndex?: number;
  /** @deprecated 旧版单图字段，只用于读取旧记录；新写入不再产生。 */
  thumbBlob?: ArrayBuffer;
  /** @deprecated 旧版缩略图 MIME；现在统一 image/jpeg。 */
  thumbMime?: string;
  tag: Tag;
  intensity: IntensityBucket;
  takenAt: string; // ISO 8601
  placeHint?: string; // 可选，模糊到城市
  // gift 专有字段
  shareId?: string;
  fromPubkey?: string;
  fromName?: string;
  acceptedAt?: string;
  // ---- v2026.4：一条 Memory 对应"一个地点" ----
  /** 对应 ShareGroup 里的 placeId */
  placeId?: string;
  /** 解密后的地点名 */
  placeName?: string;
  /** 解密后的日期 'YYYY-MM-DD' */
  dayDate?: string;
  /** 解密后的时段标签（"上午"等） */
  label?: string;
  /** 配文，下标对应 photos；没有配文的位置用空串占位 */
  captions?: string[];
  /** 接收方逐张评星 1–5，下标对应 photos，null = 未评 */
  ratings?: Array<number | null>;
}

export interface ProvenanceEdge {
  id: string;
  memoryId: string;
  shareId: string;
  fromPubkey: string;
  fromName: string;
  commitment: string; // hex
  signature: string; // hex
  chainAnchor: ChainAnchor | null;
  verified: boolean;
  acceptedAt: string;
  /** ★ 拒绝也落一条边，供 trust 计算；此时 memoryId 为空串。 */
  rejected?: boolean;
}

export interface ChainAnchor {
  type: 'local' | 'ots';
  seq: number;
  prevHash: string;
  hash: string;
  proof?: string; // OTS 时用
}

export interface ChainRecord {
  seq: number;
  hash: string;
  prevHash: string;
  event: 'share_created' | 'share_accepted' | 'share_rejected';
  refId: string;
  ts: string;
}

export interface KeyPairRecord {
  id: 'me'; // 单用户，只有一条
  privHex: string;
  pubHex: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * v2026.4 · 本地旅程模型（Trip）
 * ------------------------------------------------------------------ */

export interface TripPhoto {
  id: string;
  /** 压缩后的 JPEG 字节。存 ArrayBuffer，Safari 读回才是 ArrayBuffer。 */
  image: ArrayBuffer;
  caption?: string;
}

/** 一个地点 = 一条可分享的最小语义单元（tag/intensity 挂在它身上）。 */
export interface Place {
  id: string;
  name: string;
  /** 自由文本，例如"上午""下午" */
  label?: string;
  tag: Tag;
  intensity: IntensityBucket;
  coverIndex: number;
  /** 1–5 张 */
  photos: TripPhoto[];
}

export interface Day {
  id: string;
  /** 'YYYY-MM-DD'，允许重复 */
  date: string;
  places: Place[];
}

export interface Trip {
  id: string;
  title: string;
  coverPlaceId?: string;
  createdAt: string;
  days: Day[];
}

/**
 * 每个 group 一份屏蔽状态。层叠语义：
 * Day 隐藏 → 其下 Place/Photo/Caption 全不打包
 * Place 隐藏 → 其下 Photo/Caption 全不打包
 * Photo 隐藏 → 该 Photo 与其 Caption 不打包
 * Caption 隐藏 → Photo 打包，Caption 不打包
 */
export interface VisibilityState {
  id: string; // `${tripId}::${groupId}`
  tripId: string;
  groupId: string;
  hiddenDayIds: string[];
  hiddenPlaceIds: string[];
  hiddenPhotoIds: string[];
  hiddenCaptionPhotoIds: string[];
}

/* ------------------------------------------------------------------ *
 * 分享包 .trailshare
 * ------------------------------------------------------------------ */

/** 当前唯一的协议版本。旧版本的包在 unpack 阶段会被直接拒绝。 */
export type ShareVersion = 'ts-2026.4';

/** 一张照片：独立 IV，配文可选（被屏蔽时不出现）。 */
export interface EncryptedPhoto {
  photoId: string;
  encrypted: string; // base64
  iv: string; // base64
  encryptedCaption?: string; // base64
  ivCaption?: string; // base64
}

/**
 * 一个可见地点。tag / intensity 是明文（承诺要能被不持钥的人验证），
 * 地点名 / label / 日期全在 encryptedMeta 里。
 */
export interface EncryptedPlace {
  placeId: string;
  tag: Tag;
  intensity: IntensityBucket;
  ivMeta: string;
  encryptedMeta: string; // { name, label?, date }
  photos: EncryptedPhoto[];
}

/** 加密 meta 的明文结构。 */
export interface PlaceMeta {
  name: string;
  label?: string;
  date: string; // 'YYYY-MM-DD'
}

/**
 * KEM 的产物：用接收方的 X25519 公钥把"这把对称钥匙"单独包一份。
 * 一个接收方一条，互不可解。
 */
export interface WrappedKey {
  recipientPubkey: string;
  ephemeralPubkey: string;
  encryptedKey: string;
  iv: string;
}

/** 一组"给某些人看"的旅程切片。 */
export interface ShareGroup {
  groupId: string;
  payload: {
    cipher: 'aes-gcm';
    salt: string; // base64，进承诺
    places: EncryptedPlace[];
  };
  wrappedKeys: WrappedKey[];
}

/** 旧版承诺函数（crypto/commitment.ts 的单组实现）仍引用它，保留类型。 */
export interface MetaPlain {
  tag: Tag;
  intensity: IntensityBucket;
  takenAt: string;
  placeHint?: string;
  photoCount?: number;
}

export interface SharePackage {
  version: ShareVersion;
  shareId: string;
  from: {
    displayName: string;
    pubkey: string; // ed25519:<hex>
    sig: string; // ed25519:<hex>
  };
  groups: ShareGroup[];
  commitment: {
    hash: string; // sha256:<hex>
    algo: 'sha256';
  };
  chain: {
    prevHash: string;
    seq: number;
    anchor: null;
  };
  createdAt: string;
}

/** 被签名的规范化对象（不含 from.sig 本身）。 */
export interface SignedBody {
  version: ShareVersion;
  shareId: string;
  from: { displayName: string; pubkey: string };
  groups: ShareGroup[];
  commitment: { hash: string; algo: 'sha256' };
  chain: { prevHash: string; seq: number; anchor: null };
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Agent 层
 * ------------------------------------------------------------------ */

export interface FuseConfig {
  halfLifeDays: number; // 默认 90
  trustRejectedPenalty: number; // 默认 0.3
  verifiedBonus: number; // 默认 1.2
  strategy: 'voting' | 'trust' | 'verified';
}

export interface SocialContribution {
  fromPubkey: string;
  fromName: string;
  weight: number;
  edgeId: string;
  shareId: string;
}

export interface TagContribution {
  self: number;
  social: SocialContribution[];
}

export interface FuseInput {
  memories: Memory[];
  edges: ProvenanceEdge[];
  now: Date;
  config: FuseConfig;
}

export interface FuseOutput {
  scores: Record<Tag, number>;
  contributions: Record<Tag, TagContribution>;
}

export interface Recommendation {
  tag: Tag;
  score: number;
  reason: string;
}

export interface Explanation {
  tag: Tag;
  answer: string;
  citedEdgeIds: string[];
  citedMemoryIds: string[];
}

export interface FaithfulnessResult {
  before: Tag[];
  after: Tag[];
  flipped: boolean;
  score: number;
}

export interface Hop {
  from: string; // 显示名或公钥前缀
  to: string;
  edge: ProvenanceEdge;
  memory: Memory;
}

export interface MultihopRow {
  target: string;
  depth: number;
  singleHopWeight: number; // 本跳单边权重
  accumulatedWeight: number; // 沿路径累乘
  attenuation: number; // accumulated_d / accumulated_{d-1}
  directShare: number; // 本跳权重 / (本跳 + 上游累积)
  indirectShare: number;
}

/* ------------------------------------------------------------------ *
 * 验证结果（Share 层 → UI）
 * ------------------------------------------------------------------ */

export interface VerificationReport {
  structureOk: boolean;
  signatureOk: boolean;
  /** null = 内容不可见（加密未解密 / 仅承诺档），此刻无法判定承诺是否与内容一致 */
  commitmentOk: boolean | null;
  chainOk: boolean | null; // null = 未启用链 / 无法判定
  chainNote: string;
  errors: string[];
}
