/**
 * 实验用合成数据。纯数据构造，不碰 IndexedDB / WebCrypto，所以在 Node 里可直接跑。
 *
 * 所有时间都相对 `NOW` 写死，保证实验可复现。
 */
import type {
  ChainAnchor,
  FuseInput,
  IntensityBucket,
  Memory,
  ProvenanceEdge,
  Tag,
} from '../types';

export const NOW = new Date('2026-10-18T12:00:00Z');

export const DAY = 86_400_000;

export function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

export function makeMemory(params: {
  id: string;
  kind: 'self' | 'gift';
  tag: Tag;
  intensity: IntensityBucket;
  takenAt: string;
  fromName?: string;
  fromPubkey?: string;
  acceptedAt?: string;
  shareId?: string;
}): Memory {
  const m: Memory = {
    id: params.id,
    kind: params.kind,
    thumbBlob: new ArrayBuffer(8),
    thumbMime: 'image/jpeg',
    tag: params.tag,
    intensity: params.intensity,
    takenAt: params.takenAt,
  };
  if (params.kind === 'gift') {
    m.fromName = params.fromName;
    m.fromPubkey = params.fromPubkey;
    m.acceptedAt = params.acceptedAt;
    m.shareId = params.shareId;
  }
  return m;
}

export function makeEdge(params: {
  id: string;
  memoryId: string;
  shareId: string;
  fromName: string;
  fromPubkey: string;
  acceptedAt: string;
  verified?: boolean;
  rejected?: boolean;
  anchor?: ChainAnchor | null;
}): ProvenanceEdge {
  return {
    id: params.id,
    memoryId: params.memoryId,
    shareId: params.shareId,
    fromPubkey: params.fromPubkey,
    fromName: params.fromName,
    commitment: 'sha256:' + '0'.repeat(64),
    signature: 'ed25519:' + '0'.repeat(128),
    chainAnchor: params.anchor ?? null,
    verified: params.verified ?? true,
    acceptedAt: params.acceptedAt,
    ...(params.rejected ? { rejected: true } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 三个朋友：A 老朋友且可信、B 新朋友、C 有过被拒记录
 * ------------------------------------------------------------------ */

export const PK = {
  A: 'a'.repeat(64),
  B: 'b'.repeat(64),
  C: 'c'.repeat(64),
  D: 'd'.repeat(64),
};

export interface Scenario {
  input: FuseInput;
  memories: Memory[];
  edges: ProvenanceEdge[];
}

/**
 * 场景设计意图：
 * - 自己：都市 ×2（近）、美食 ×1（近）、休闲 ×1（久）、人文 ×1（久）
 * - A（可信、近期、已验证）：自然 high
 * - B（新朋友、三年前、已验证）：人文 mid
 * - C（有过拒绝、近期、未验证）：自然 mid、都市 high
 * 这样"自然"在 voting 与 verified 下的排名会不同：
 * voting 里 C 的未验证边与 A 的权重差被抹平，verified 里 A 被抬高。
 */
export function buildScenario(): Scenario {
  const memories: Memory[] = [
    makeMemory({ id: 'm1', kind: 'self', tag: 'metropolis', intensity: 'high', takenAt: daysAgo(20) }),
    makeMemory({ id: 'm2', kind: 'self', tag: 'metropolis', intensity: 'mid', takenAt: daysAgo(45) }),
    makeMemory({ id: 'm3', kind: 'self', tag: 'food', intensity: 'high', takenAt: daysAgo(12) }),
    makeMemory({ id: 'm4', kind: 'self', tag: 'leisure', intensity: 'mid', takenAt: daysAgo(260) }),
    makeMemory({ id: 'm5', kind: 'self', tag: 'heritage', intensity: 'mid', takenAt: daysAgo(400) }),
    makeMemory({
      id: 'g1',
      kind: 'gift',
      tag: 'nature',
      intensity: 'high',
      takenAt: daysAgo(60),
      acceptedAt: daysAgo(30),
      fromName: 'A',
      fromPubkey: PK.A,
      shareId: 's_a1',
    }),
    makeMemory({
      id: 'g2',
      kind: 'gift',
      tag: 'heritage',
      intensity: 'mid',
      takenAt: daysAgo(1200),
      acceptedAt: daysAgo(1100),
      fromName: 'B',
      fromPubkey: PK.B,
      shareId: 's_b1',
    }),
    makeMemory({
      id: 'g3',
      kind: 'gift',
      tag: 'nature',
      intensity: 'mid',
      takenAt: daysAgo(15),
      acceptedAt: daysAgo(10),
      fromName: 'C',
      fromPubkey: PK.C,
      shareId: 's_c1',
    }),
    makeMemory({
      id: 'g4',
      kind: 'gift',
      tag: 'metropolis',
      intensity: 'high',
      takenAt: daysAgo(5),
      acceptedAt: daysAgo(2),
      fromName: 'C',
      fromPubkey: PK.C,
      shareId: 's_c2',
    }),
  ];

  const edges: ProvenanceEdge[] = [
    makeEdge({
      id: 'e1',
      memoryId: 'g1',
      shareId: 's_a1',
      fromName: 'A',
      fromPubkey: PK.A,
      acceptedAt: daysAgo(30),
      verified: true,
    }),
    makeEdge({
      id: 'e2',
      memoryId: 'g2',
      shareId: 's_b1',
      fromName: 'B',
      fromPubkey: PK.B,
      acceptedAt: daysAgo(1100),
      verified: true,
    }),
    makeEdge({
      id: 'e3',
      memoryId: 'g3',
      shareId: 's_c1',
      fromName: 'C',
      fromPubkey: PK.C,
      acceptedAt: daysAgo(10),
      verified: false,
    }),
    makeEdge({
      id: 'e4',
      memoryId: 'g4',
      shareId: 's_c2',
      fromName: 'C',
      fromPubkey: PK.C,
      acceptedAt: daysAgo(2),
      verified: false,
    }),
    // C 曾被拒绝过一次：只落边，不落记忆
    makeEdge({
      id: 'e_rej',
      memoryId: '',
      shareId: 's_c0',
      fromName: 'C',
      fromPubkey: PK.C,
      acceptedAt: daysAgo(40),
      rejected: true,
    }),
  ];

  return {
    input: {
      memories,
      edges,
      now: NOW,
      config: {
        halfLifeDays: 90,
        trustRejectedPenalty: 0.3,
        verifiedBonus: 1.2,
        strategy: 'verified',
      },
    },
    memories,
    edges,
  };
}

/** 只看 A→B→C→D 的一条链，给 E4 用。 */
export function buildHopChain(): { memories: Memory[]; edges: ProvenanceEdge[] } {
  const memories: Memory[] = [
    makeMemory({
      id: 'h1',
      kind: 'gift',
      tag: 'nature',
      intensity: 'high',
      takenAt: daysAgo(40),
      acceptedAt: daysAgo(20),
      fromName: 'A',
      fromPubkey: PK.A,
      shareId: 's_h1',
    }),
    makeMemory({
      id: 'h2',
      kind: 'gift',
      tag: 'nature',
      intensity: 'high',
      takenAt: daysAgo(40),
      acceptedAt: daysAgo(14),
      fromName: 'B',
      fromPubkey: PK.B,
      shareId: 's_h2',
    }),
    makeMemory({
      id: 'h3',
      kind: 'gift',
      tag: 'nature',
      intensity: 'high',
      takenAt: daysAgo(40),
      acceptedAt: daysAgo(7),
      fromName: 'C',
      fromPubkey: PK.C,
      shareId: 's_h3',
    }),
  ];
  const edges: ProvenanceEdge[] = [
    makeEdge({
      id: 'he1',
      memoryId: 'h1',
      shareId: 's_h1',
      fromName: 'A',
      fromPubkey: PK.A,
      acceptedAt: daysAgo(20),
      verified: true,
    }),
    makeEdge({
      id: 'he2',
      memoryId: 'h2',
      shareId: 's_h2',
      fromName: 'B',
      fromPubkey: PK.B,
      acceptedAt: daysAgo(14),
      verified: true,
    }),
    makeEdge({
      id: 'he3',
      memoryId: 'h3',
      shareId: 's_h3',
      fromName: 'C',
      fromPubkey: PK.C,
      acceptedAt: daysAgo(7),
      verified: true,
    }),
  ];
  return { memories, edges };
}

/**
 * E2 专用场景：刻意让多个标签的分数彼此接近，
 * 这样"移除一条边是否翻转 top-3"才有区分度。
 *
 * 设计意图：
 * - 自己只有都市 / 美食，社会边才是自然、人文、休闲、水乡的主要来源
 * - 自然与人文本就贴身竞争（1.48 vs 1.46），移除任意一边都会翻转
 * - 水乡始终排在榜外 —— 这条解释注定"不忠实"，用来展示指标能抓出模板解释
 */
export function buildE2Scenario(): Scenario {
  const memories: Memory[] = [
    makeMemory({ id: 's1', kind: 'self', tag: 'metropolis', intensity: 'high', takenAt: daysAgo(10) }),
    makeMemory({ id: 's2', kind: 'self', tag: 'food', intensity: 'mid', takenAt: daysAgo(60) }),
    makeMemory({
      id: 'n1',
      kind: 'gift',
      tag: 'nature',
      intensity: 'high',
      takenAt: daysAgo(50),
      acceptedAt: daysAgo(12),
      fromName: 'A',
      fromPubkey: PK.A,
      shareId: 's_e2_a',
    }),
    makeMemory({
      id: 'n2',
      kind: 'gift',
      tag: 'nature',
      intensity: 'mid',
      takenAt: daysAgo(30),
      acceptedAt: daysAgo(6),
      fromName: 'D',
      fromPubkey: PK.D,
      shareId: 's_e2_d1',
    }),
    makeMemory({
      id: 'n3',
      kind: 'gift',
      tag: 'heritage',
      intensity: 'mid',
      takenAt: daysAgo(200),
      acceptedAt: daysAgo(20),
      fromName: 'B',
      fromPubkey: PK.B,
      shareId: 's_e2_b',
    }),
    makeMemory({
      id: 'n4',
      kind: 'gift',
      tag: 'heritage',
      intensity: 'low',
      takenAt: daysAgo(90),
      acceptedAt: daysAgo(9),
      fromName: 'D',
      fromPubkey: PK.D,
      shareId: 's_e2_d2',
    }),
    makeMemory({
      id: 'n5',
      kind: 'gift',
      tag: 'leisure',
      intensity: 'mid',
      takenAt: daysAgo(70),
      acceptedAt: daysAgo(5),
      fromName: 'D',
      fromPubkey: PK.D,
      shareId: 's_e2_d3',
    }),
    makeMemory({
      id: 'n6',
      kind: 'gift',
      tag: 'food',
      intensity: 'low',
      takenAt: daysAgo(40),
      acceptedAt: daysAgo(15),
      fromName: 'A',
      fromPubkey: PK.A,
      shareId: 's_e2_a2',
    }),
    makeMemory({
      id: 'n7',
      kind: 'gift',
      tag: 'watertown',
      intensity: 'low',
      takenAt: daysAgo(300),
      acceptedAt: daysAgo(200),
      fromName: 'C',
      fromPubkey: PK.C,
      shareId: 's_e2_c',
    }),
  ];

  const mk = (
    id: string,
    memoryId: string,
    shareId: string,
    fromName: string,
    fromPubkey: string,
    acceptedDays: number,
  ): ProvenanceEdge =>
    makeEdge({
      id,
      memoryId,
      shareId,
      fromName,
      fromPubkey,
      acceptedAt: daysAgo(acceptedDays),
      verified: true,
    });

  const edges: ProvenanceEdge[] = [
    mk('ee1', 'n1', 's_e2_a', 'A', PK.A, 12),
    mk('ee2', 'n2', 's_e2_d1', 'D', PK.D, 6),
    mk('ee3', 'n3', 's_e2_b', 'B', PK.B, 20),
    mk('ee4', 'n4', 's_e2_d2', 'D', PK.D, 9),
    mk('ee5', 'n5', 's_e2_d3', 'D', PK.D, 5),
    mk('ee6', 'n6', 's_e2_a2', 'A', PK.A, 15),
    mk('ee7', 'n7', 's_e2_c', 'C', PK.C, 200),
  ];

  return {
    input: {
      memories,
      edges,
      now: NOW,
      config: {
        halfLifeDays: 90,
        trustRejectedPenalty: 0.3,
        verifiedBonus: 1.2,
        strategy: 'verified',
      },
    },
    memories,
    edges,
  };
}

/**
 * E3 的"贴身竞争"场景：刻意让两条社会边的权重只差 12%，
 * 且一条已验证、一条未验证——这样"验证加权"才有机会改变 top-1，
 * 否则它只是把所有社会分数同比例放大，排名不会动。
 *
 * 设计（刻意只放两条互相竞争的社会边，不放个人记忆，避免强项把两条边都压过去）：
 * - A（1 次接受 → trust 0.5）：自然，10 天前，已验证 → 权重 ≈ 0.556
 * - C（2 次接受 → trust 2/3）：人文，40 天前，未验证 → 权重 ≈ 0.490
 * 于是 trust 策略下人文赢，verified 策略下自然反超；
 * 而 voting 只看票数（1:1 平票，按标签字典序），会给出第三个答案。
 */
export function buildTightScenario(): Scenario {
  const memories: Memory[] = [
    makeMemory({
      id: 't1',
      kind: 'gift',
      tag: 'nature',
      intensity: 'high',
      takenAt: daysAgo(15),
      acceptedAt: daysAgo(10),
      fromName: 'A',
      fromPubkey: PK.A,
      shareId: 's_t1',
    }),
    makeMemory({
      id: 't2',
      kind: 'gift',
      tag: 'heritage',
      intensity: 'high',
      takenAt: daysAgo(45),
      acceptedAt: daysAgo(40),
      fromName: 'C',
      fromPubkey: PK.C,
      shareId: 's_t2',
    }),
    makeMemory({
      id: 't3',
      kind: 'gift',
      tag: 'watertown',
      intensity: 'low',
      takenAt: daysAgo(2000),
      acceptedAt: daysAgo(1990),
      fromName: 'C',
      fromPubkey: PK.C,
      shareId: 's_t3',
    }),
  ];

  const edges: ProvenanceEdge[] = [
    makeEdge({
      id: 'te1',
      memoryId: 't1',
      shareId: 's_t1',
      fromName: 'A',
      fromPubkey: PK.A,
      acceptedAt: daysAgo(10),
      verified: true,
    }),
    makeEdge({
      id: 'te2',
      memoryId: 't2',
      shareId: 's_t2',
      fromName: 'C',
      fromPubkey: PK.C,
      acceptedAt: daysAgo(40),
      verified: false,
    }),
    makeEdge({
      id: 'te3',
      memoryId: 't3',
      shareId: 's_t3',
      fromName: 'C',
      fromPubkey: PK.C,
      acceptedAt: daysAgo(1990),
      verified: false,
    }),
  ];

  return {
    input: {
      memories,
      edges,
      now: NOW,
      config: {
        halfLifeDays: 90,
        trustRejectedPenalty: 0.3,
        verifiedBonus: 1.2,
        strategy: 'verified',
      },
    },
    memories,
    edges,
  };
}
