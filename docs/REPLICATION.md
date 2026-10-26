# TrailShare 复刻规范（v2026.4）

> 这份文档的目标：**另一个 AI 只看这一份，就能从空目录复刻出行为等价的项目。**
> 它写的是"必须实现成什么样"，不是"我们当时怎么想的"。所有数字、公式、字段名、
> 文件路径都来自当前仓库，可直接当作验收标准。
>
> 版本：协议 `ts-2026.4`，应用 `0.2.0`，测试 **204 / 15 文件**。

---

## 0. 复刻完成的定义（DoD）

在空目录里执行完本文第 11 节的路线后，必须同时满足：

```bash
npm test -- --no-file-parallelism     # 204 passed (15 files)
npm run build                         # tsc --noEmit && vite build 成功
npx tsx src/experiments/e1_privacy.ts # 0.000 / 0.833 / 0.983
npx tsx src/experiments/e2_faithfulness.ts # 平均忠实度 0.833（5/6 翻转）
npx tsx src/experiments/e3_ablation.ts     # 1/6 与 4/6
npx tsx src/experiments/e4_multihop.ts     # 15.8%
```

数字必须**逐位一致**。实验脚本不允许为了凑数而改；它们是回归基线。

---

## 1. 产品定义

### 1.1 一句话

零后端、纯前端的"旅行记忆信物"：用户把一段旅程（多天、多地点、每张照片可带配文）
整理成本地数据，选择**哪些天/地点/照片/配文可以打包**，加密成一个 `.trailshare` 文件，
只有指定收件人能解开；收件人接受后，其推荐助手能引用"这条偏好来自 A"，并可用
"拿掉这条来源，推荐是否翻转"来自动检验解释是否忠实。

### 1.2 核心用户旅程

```
A：旅程页建 Trip（天 → 地点 → 照片 + 配文）
   → 生成信物页选 Trip
   → 在可见性树里取消勾选不想分享的条目（= 不打包）
   → 勾收件人（可多组，每组独立可见性与收件人）
   → 生成并下载 .trailshare

B：导入信物页拖入文件
   → 本机验签 + 承诺比对 + KEM 解封
   → 只看到"给自己的那些地点"组成的连续时间线（没有占位、没有总数）
   → 接受 → 每个地点落一条 Memory + 一条溯源边
   → 在记忆库逐张评星（1–5，再点同一颗取消）
   → 问 Agent"为什么推荐自然风光" → 回答引用 shareId
   → 反事实检验：拿掉这些边，top-3 是否翻转
```

### 1.3 明确不做

| 不做 | 理由（复刻时必须保留这段说明） |
|---|---|
| 后端 / 账号系统 | 零后端是前提；文件传递足够 |
| 地图 API / 地理编码 | 地点名手写，避免位置精确化与外部依赖 |
| 原图上传/云备份 | 照片永不离开设备，只有压缩后的字节进加密流程 |
| 实时加好友协议 | 需要在线状态与密钥目录；公钥靠带外交换 |
| 旧协议兼容 | v2026.3 及更早直接拒绝，避免语义错位 |
| LLM 参与决策 | LLM 只做查询解析与润色；排序、引用、反事实全由规则层决定 |

### 1.4 术语

| 术语 | 含义 |
|---|---|
| Trip | 一次旅程，含若干 Day |
| Day | 一天，`date` 为 `YYYY-MM-DD`，允许重复 |
| Place | 一个地点，是分享的最小语义单元；`tag`/`intensity` 挂在它上面 |
| Visibility | 每组一份屏蔽状态；屏蔽 = **不打包** |
| Group | 一个包内的一组内容，有自己的可见性与收件人列表 |
| Edge | 溯源边：一条"我从某人那里接受了某个地点"的记录 |
| Commitment | 对可见 place 的 `(placeId, tag, intensity)` + 每组盐的 SHA256 |

---

## 2. 技术栈与工程约束

### 2.1 技术栈（版本锁死）

| 层 | 选型 | 版本 |
|---|---|---|
| 语言 | TypeScript | ^5.5.0，`strict` + `noUnusedLocals` + `noUnusedParameters` |
| 构建 | Vite | ^5.4.0 |
| 测试 | Vitest | ^2.0.0（`environment: 'node'`） |
| 存储 | idb | ^8.0.0 |
| 曲线/哈希 | @noble/curves | ^2.4.0 |
|  | @noble/ed25519 | ^2.1.0 |
|  | @noble/hashes | ^1.4.0 |
| 测试用 | fake-indexeddb | ^6.2.6 |
| 脚本 | tsx | ^4.19.0 |

`vite.config.ts`（同时承载 Vitest 配置）：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist', sourcemap: false },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], reporters: 'default' },
});
```

`tsconfig.json` 关键项：`target/lib ES2022 + DOM`、`moduleResolution: bundler`、
`allowImportingTsExtensions`、`isolatedModules`、`noEmit`、`strict`、`noUnusedLocals`、
`noUnusedParameters`、`noFallthroughCasesInSwitch`，`types: ["vite/client"]`。

### 2.2 运行环境要求

- 必须通过 `http(s)://` 打开；`file://` 下 IndexedDB 与 WebCrypto 不可用。
- 需要 `crypto.subtle`、`crypto.getRandomValues`、Canvas 2D、`createImageBitmap`。
- Ed25519 优先用 WebCrypto（Chrome 137+/Safari 17+/Firefox 129+），失败自动降级 `@noble/ed25519`；
  两条路径共用 32 字节种子，密钥可互操作。

### 2.3 分层边界（硬规则，违反就会让 Node 测试挂）

| 层 | 允许 | 禁止 |
|---|---|---|
| `agent/*`（决策相关）、`crypto/commitment.ts`、`crypto/chain.ts`、`utils/time.ts`、`utils/trust.ts` | 纯函数 | IndexedDB、`crypto.subtle`、`Date.now()`、网络 |
| `crypto/{keys,sign,encrypt}.ts` | 内部可用 WebCrypto / noble | 对外只收发 `Uint8Array` / `string` |
| `store/*` | CRUD + `ArrayBuffer` 转换 | 任何算法 |
| `share/*` | 组合 crypto + filter | 访问数据库 |
| `ui/*` | DOM、调 store/agent | 把算法塞进渲染函数 |

**所有需要"现在"的函数都必须显式接收 `now: Date`**，这是实验可复现的前提。

### 2.4 仓库结构（完整）

```
trailshare/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md
├── QUICKSTART.md
├── .env.example
├── .gitignore
├── public/demo-photos/README.md
├── src/
│   ├── main.ts                  # 入口：SHELL、身份、5 个 Tab、seedDemoFriends
│   ├── types.ts                 # 全部类型（唯一类型源）
│   ├── config.ts                # localStorage：chain_enabled / display_name
│   ├── style.css                # 手写 CSS
│   ├── crypto/
│   │   ├── keys.ts              # Ed25519 + X25519（同种子派生）
│   │   ├── sign.ts              # canonical JSON + sign/verify
│   │   ├── encrypt.ts           # AES-GCM + KEM(HKDF/X25519) + 旧 PBKDF2
│   │   ├── commitment.ts        # v2026.3 单组 + v2026.4 组织承诺
│   │   └── chain.ts             # L0 本地哈希链（纯函数）
│   ├── share/
│   │   ├── schema.ts            # 版本、上限、版本解析
│   │   ├── pack.ts              # 封装
│   │   └── unpack.ts            # 验证/解封 + unpackForViewer
│   ├── store/
│   │   ├── db.ts                # 主库 trailshare
│   │   ├── keys.ts              # 本机身份
│   │   ├── memories.ts          # Memory CRUD + 归一化
│   │   ├── provenance.ts        # Edge CRUD + 批删
│   │   ├── chainStore.ts        # 链 CRUD + health
│   │   ├── trips.ts             # 独立库 trailshare-trips（trips+visibility）
│   │   ├── visibility.ts        # 屏蔽状态 + withHidden
│   │   ├── ratings.ts           # 逐张评星（写 Memory.ratings）
│   │   └── friends.ts           # 独立库 trailshare-friends
│   ├── agent/
│   │   ├── fuse.ts              # ★ 冲突融合
│   │   ├── recommend.ts         # 排序（recommend / rankTags）
│   │   ├── explain.ts           # 规则解释 + explainWithLLM
│   │   ├── counterfactual.ts    # ★ 反事实忠实度
│   │   ├── multihop.ts          # ★ 多跳衰减
│   │   ├── ratingAdapter.ts     # 评星 → fuse 输入
│   │   ├── llm_client.ts        # OpenAI 兼容客户端（超时/重试/熔断）
│   │   ├── query_parse_llm.ts   # 问题 → 槽位
│   │   ├── llm_paraphrase.ts    # 润色
│   │   └── self_check.ts        # 引用一致性校验
│   ├── utils/
│   │   ├── filter.ts            # ★ 可见性层叠过滤（纯函数）
│   │   ├── image.ts             # 压缩（720px / q0.7）、data URL
│   │   ├── photoList.ts         # 旧版照片组纯函数（APP 已不引用，仅测试引用；见 §10.1 注）
│   │   ├── time.ts              # 衰减/格式化（纯函数）
│   │   ├── trust.ts             # 信任分（纯函数）
│   │   ├── hash.ts / base64.ts / binary.ts / id.ts
│   └── experiments/
│       ├── fixtures.ts          # 固定 NOW 与合成数据
│       ├── e1_privacy.ts … e4_multihop.ts
│       └── run_all.ts
└── tests/                       # 15 个文件，见第 10 节
```

---

## 3. 数据模型（`src/types.ts`）

### 3.1 标签与强度

```ts
export type Tag = 'heritage' | 'nature' | 'watertown' | 'metropolis' | 'food' | 'leisure';
export type IntensityBucket = 'low' | 'mid' | 'high';

export const TAG_LABELS: Record<Tag, string> = {
  heritage: '人文历史', nature: '自然风光', watertown: '水乡古镇',
  metropolis: '都市风光', food: '美食探索', leisure: '休闲度假',
};
export const INTENSITY_STARS: Record<IntensityBucket, string> = { low: '★', mid: '★★', high: '★★★' };
export const INTENSITY_MEANING: Record<IntensityBucket, string> = { low: '一般', mid: '喜欢', high: '强烈推荐' };
```

`ALL_TAGS` 的顺序就是所有"平票时"的稳定排序依据，不要改动。

### 3.2 旅程模型

```ts
export interface TripPhoto {
  id: string;
  image: ArrayBuffer;   // 压缩后的 JPEG 字节
  caption?: string;
}

export interface Place {
  id: string;
  name: string;         // 手写，不用地图 API
  label?: string;       // "上午"/"下午"等自由文本
  tag: Tag;
  intensity: IntensityBucket;
  coverIndex: number;
  photos: TripPhoto[];  // 1–5 张
}

export interface Day {
  id: string;
  date: string;         // 'YYYY-MM-DD'，允许重复
  places: Place[];
}

export interface Trip {
  id: string;           // `t_` + 8 位
  title: string;
  coverPlaceId?: string;
  createdAt: string;    // ISO
  days: Day[];
}

export interface VisibilityState {
  id: string;           // `${tripId}::${groupId}`
  tripId: string;
  groupId: string;
  hiddenDayIds: string[];
  hiddenPlaceIds: string[];
  hiddenPhotoIds: string[];
  hiddenCaptionPhotoIds: string[];
}
```

### 3.3 分享包

```ts
export type ShareVersion = 'ts-2026.4';

export interface EncryptedPhoto {
  photoId: string;
  encrypted: string;        // base64
  iv: string;               // base64
  encryptedCaption?: string; // 有配文且未被屏蔽才有
  ivCaption?: string;
}

export interface EncryptedPlace {
  placeId: string;
  tag: Tag;                 // 明文
  intensity: IntensityBucket; // 明文
  ivMeta: string;
  encryptedMeta: string;    // 密文 { name, label?, date }
  photos: EncryptedPhoto[];
}

export interface WrappedKey {
  recipientPubkey: string;  // bare hex
  ephemeralPubkey: string;
  encryptedKey: string;
  iv: string;
}

export interface ShareGroup {
  groupId: string;          // `g{i}_{6 位}`
  payload: { cipher: 'aes-gcm'; salt: string; places: EncryptedPlace[] };
  wrappedKeys: WrappedKey[];
}

export interface SharePackage {
  version: ShareVersion;
  shareId: string;          // `s_` + 8 位
  from: { displayName: string; pubkey: string; sig: string };
  groups: ShareGroup[];
  commitment: { hash: string; algo: 'sha256' };
  chain: { prevHash: string; seq: number; anchor: null };
  createdAt: string;
}

export interface SignedBody {
  version: ShareVersion;
  shareId: string;
  from: { displayName: string; pubkey: string };
  groups: ShareGroup[];
  commitment: { hash: string; algo: 'sha256' };
  chain: { prevHash: string; seq: number; anchor: null };
  createdAt: string;
}
```

`PlaceMeta`（只存在于密文里）：`{ name: string; label?: string; date: string }`。

### 3.4 本地记忆 / 溯源 / 链

```ts
export interface Memory {
  id: string;
  kind: 'self' | 'gift';
  photos?: ArrayBuffer[];       // 新记录必填；缺省时兼容旧 thumbBlob
  coverIndex?: number;
  thumbBlob?: ArrayBuffer;      // @deprecated 只读旧数据
  thumbMime?: string;
  tag: Tag;                     // ★ fuse 依赖顶层 tag
  intensity: IntensityBucket;   // ★ 同上
  takenAt: string;              // ISO（用日期当天中午，见 §4.3）
  placeHint?: string;
  shareId?: string;
  fromPubkey?: string;
  fromName?: string;
  acceptedAt?: string;
  // v2026.4
  placeId?: string;
  placeName?: string;
  dayDate?: string;             // 'YYYY-MM-DD'
  label?: string;
  captions?: string[];          // 下标对应 photos
  ratings?: Array<number | null>; // 下标对应 photos
}

export interface ProvenanceEdge {
  id: string;
  memoryId: string;
  shareId: string;
  fromPubkey: string;
  fromName: string;
  commitment: string;
  signature: string;
  chainAnchor: ChainAnchor | null;
  verified: boolean;
  acceptedAt: string;
  rejected?: boolean;           // 拒绝也落边
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
  id: 'me';
  privHex: string;  // 32 字节种子 hex
  pubHex: string;
  createdAt: string;
}
```

`ThumbBlob` 之所以保留可选：`src/experiments/fixtures.ts` 用旧字段构造 Memory，而实验文件不允许改。
运行时一律通过 `photosOf()` 归一化。

### 3.5 验证报告

```ts
export interface VerificationReport {
  structureOk: boolean;
  signatureOk: boolean;
  commitmentOk: boolean | null; // null = 无法比对
  chainOk: boolean | null;      // null = 未启用 / 无法判定
  chainNote: string;
  errors: string[];
}
```

---

## 4. 存储层

### 4.1 三个独立 IndexedDB（不要合并）

| 库名 | 版本 | store | keyPath | 索引 |
|---|---|---|---|---|
| `trailshare` | 1 | `memories` | `id` | `by-kind`→`kind`，`by-tag`→`tag` |
|  |  | `edges` | `id` | `by-memory`→`memoryId` |
|  |  | `chain` | `seq` | — |
|  |  | `keys` | `id` | — |
| `trailshare-friends` | 1 | `friends` | `pubkey` | — |
| `trailshare-trips` | 1 | `trips` | `id` | — |
|  |  | `visibility` | `id` | — |

为什么拆三个库：`store/db.ts` 的表结构在后续迭代里被锁定不允许改，而好友/旅程属于
"本机通讯录/草稿"，与记忆没有事务关联。**复刻时可以合并，但必须保持同样的访问语义。**

### 4.2 关键 CRUD 语义

| 函数 | 语义 |
|---|---|
| `ensureKeyPair(now)` | 首次生成 32 字节种子并写 `keys/me`；已存在直接返回 |
| `putMemory(m)` | 归一化：`photosOf` → 独立 `ArrayBuffer`，`coverIndex` 纠偏，删除 `thumbBlob/thumbMime` |
| `listMemories()` | 按 `takenAt` 倒序 |
| `deleteMemory(id)` | 删记忆 + `deleteEdgesByMemoryId`；**链表不动**（只追加） |
| `putEdge / listEdges` | 按 `acceptedAt` 升序 |
| `deleteEdgesByMemoryId(id)` | 返回删除数量；无关联边返回 0，不抛错 |
| `appendChainRecord(event, refId, sig, ts)` | 取最后一条 → `appendChain` → 写入 |
| `putTrip / getTrip / listTrips` | 整对象读写；`listTrips` 按 `createdAt` 倒序 |
| `deleteTrip(id)` | 删 Trip + 该 Trip 的所有 visibility 行 |
| `getVisibility(tripId, groupId)` | 缺记录时返回全可见空状态，不写库 |
| `withHidden(state, kind, id, hidden)` | 纯函数，返回新状态，去重/过滤 |
| `setPhotoRating(memoryId, i, score)` | 校验 1–5 或 null、下标合法；写回 `Memory.ratings` |
| `addFriend / removeFriend / listFriends` | 公钥规范化 `ed25519:<64hex>`；X25519 公钥由 Ed25519 派生 |
| `seedDemoFriends()` | friends 表为空时插入 3 个固定种子（`11…`/`22…`/`33…`），幂等 |

### 4.3 两个工程约定

1. **IndexedDB 一律存 `ArrayBuffer`**：Safari 存 `Uint8Array` 可能读回 `ArrayBuffer`。
   所有读写过 `toStorage` / `fromStorage`。
2. **`takenAt` 用日期当天 12:00（本地时区）**：`new Date(\`${date}T12:00:00\`)`。
   用 00:00 会在东八区被 UTC 化后退到前一天，导致时间线错位。

---

## 5. 密码学

### 5.1 身份：一份种子，两套密钥

```ts
// 32 字节种子 = Ed25519 私钥；公钥由 noble 推导
publicKeyFromSeed(privHex): bytesToHex(ed.getPublicKey(hexToBytes(privHex)))

// Ed25519 种子 → X25519（RFC 7748）
x25519Priv = ed25519.utils.toMontgomerySecret(seed) // clamp(SHA512(seed)[0..32])
x25519Pub  = x25519.getPublicKey(x25519Priv)

// 只有对方 Ed25519 公钥时
recipientX25519Pub = ed25519.utils.toMontgomery(ed25519PubBytes)
```

### 5.2 签名

- 签名对象是**规范化 JSON 字节**，不是对象。
- `canonicalJson`：递归按 key 字典序；数组保持顺序；过滤 `undefined`；字符串用 `JSON.stringify`。
- 签名格式 `ed25519:<128 hex>`；验签前剥前缀，长度必须 64 字节。
- `SignedBody` 不含 `from.sig`，避免自引用。

### 5.3 AES-GCM

- 每次加密随机 **12 字节 IV**；输出 `{ ivB64, dataB64 }`。
- 照片、meta、配文都用同一把组密钥，但**各自独立 IV**（一张照片一个）。
- AES-GCM 自带完整性，改一字节即解密失败。

### 5.4 KEM（把组密钥包给每个收件人）

对每个收件人：

```
ephPriv = x25519.randomSecretKey()          // 每次新生成，绝不复用
ephPub  = x25519.getPublicKey(ephPriv)
shared  = x25519.getSharedSecret(ephPriv, recipientX25519Pub)
salt    = sha256(ephPub || recipientX25519Pub)
wrapKey = HKDF-SHA256(ikm=shared, salt=salt, info=utf8('trailshare-kem-v1'), L=32)
{ encryptedKey, iv } = AES-GCM(wrapKey, keyBytes)   // 12 字节随机 IV
```

解封：用自己的 X25519 私钥 + `ephPub` 重算 `shared`，派生同一把 `wrapKey`；
AES-GCM 解不开 → 抛 `not-a-recipient`（不区分"不是给你"与"数据坏了"）。

### 5.5 承诺

**v2026.4（当前）**：

```
groupPart(g) = [g.groupId, g.salt,
                ...g.places.sort(by placeId).flatMap(p => [p.placeId, p.tag, p.intensity])
               ].join('||')
input = groups.sort(by groupId).map(groupPart).join('||')
hash  = 'sha256:' + SHA256_hex(input)
```

覆盖：可见 place 的 `(placeId, tag, intensity)` 有序列表 + 每组盐。
不覆盖：日期、地点名、label、配文、照片本身（它们都在密文里）。

旧版 `commitmentInput(tag, salt, intensity)` 等函数保留（`tests/crypto.test.ts` 用），
但 v2026.4 的 pack/unpack 不再调用。

### 5.6 哈希链

```
GENESIS_HASH = '0'.repeat(64)
chainHash = SHA256(`${shareId}||${sig}||${stripAlgo(prevHash)}||${seq}`)
seq       = prev ? prev.seq + 1 : 0
prevHash  = prev ? prev.hash : GENESIS_HASH
```

`verifyChainLink(records)` 只检查连接性（seq 连续、prevHash 指向上一条、首条指向 GENESIS）；
`verifyRecordHash(record, sig)` 复核哈希值。链关闭时 `anchor=null`、`seq=0`，功能不受影响。

---

## 6. 协议

### 6.1 `pack(input)` 精确步骤

```ts
interface PackGroupInput { trip: Trip; visibility: VisibilityState; recipientPubkeys: string[]; }
interface PackInput {
  groups: PackGroupInput[];
  senderIdentity: Identity;
  displayName?: string;
  prevChain?: ChainRecord | null;
  chainEnabled?: boolean;
  now?: Date;
  shareId?: string;
}
interface PackResult { pkg: SharePackage; visible: FilterResult[]; chainRecord: ChainRecord | null; }
```

1. 校验 `groups` 长度 1–3；发送方身份存在。
2. 每组：
   - `filtered = applyVisibility(trip, visibility)`；
   - `visiblePlaces.length === 0` → 抛 `第 N 组没有任何可见内容`；
   - 每个地点可见照片数 1–5，字节非空；
   - `salt = base64(random(16))`；`key = random(32)`；`aes = importAesKey(key)`；
   - 每个可见 place（按 filter 顺序）：
     - `meta = { name, label?, date }` → `AES-GCM(key, ivMeta)`；
     - 每张可见 photo：`AES-GCM(key, ivPhoto)`；若 `includeCaption && caption`，再加密配文；
     - 写入 `{ placeId, tag, intensity, ivMeta, encryptedMeta, photos }`；
   - `wrappedKeys = wrapKeyForRecipients(key, recipients, sender.x25519Priv)`；
   - `groupId = g{i+1}_{uuid6}`；承诺输入用**包内实际写入的 places**。
3. `commitment = groupPlacesCommitmentValue(inputs)`。
4. 链：`chainEnabled===false` → `prevHash=GENESIS, seq=0`；否则取 `prevChain?.hash` 与 `seq+1`。
5. `body: SignedBody` → `sig = signCanonical(body, privHex)` → `pkg = { ...body, from: { ...from, sig } }`。
6. `chainRecord`（关闭时为 null）。

### 6.2 包结构（示例）

```jsonc
{
  "version": "ts-2026.4",
  "shareId": "s_da394434",
  "from": { "displayName": "A", "pubkey": "ed25519:…", "sig": "ed25519:…" },
  "groups": [{
    "groupId": "g1_ab12cd",
    "payload": {
      "cipher": "aes-gcm",
      "salt": "…",
      "places": [{
        "placeId": "p_1a2b3c4d",
        "tag": "heritage",
        "intensity": "high",
        "ivMeta": "…",
        "encryptedMeta": "…",
        "photos": [{
          "photoId": "ph_9f8e7d6c",
          "encrypted": "…", "iv": "…",
          "encryptedCaption": "…", "ivCaption": "…"
        }]
      }]
    },
    "wrappedKeys": [{ "recipientPubkey": "…", "ephemeralPubkey": "…", "encryptedKey": "…", "iv": "…" }]
  }],
  "commitment": { "hash": "sha256:…", "algo": "sha256" },
  "chain": { "prevHash": "000…", "seq": 0, "anchor": null },
  "createdAt": "2026-10-21T…"
}
```

### 6.3 `unpack(input, cred)` 精确步骤

1. **版本闸门**：`versionMinor(version) < 4` → 抛 `OldShareVersionError`
   （消息固定：`此信物为旧版本，请让发送方重新生成`）。更高版本 → 结构错误"请升级本应用"。
2. 结构校验：`groups[].payload.places[].photos[]`、tag/intensity 枚举、caption 两字段成对。
3. 验签：`verifyCanonical(bodyOf(pkg), sig, pubkey)`。
4. 承诺：用**公开字段**复算，不需要密钥。
5. 链三态：关闭→null；`seq=0 && prevHash=GENESIS`→true；`prevHash` 命中本地账本→true；
   否则 null（跨设备属预期）。`chainNote` 必须写清是哪一种。
6. 逐组：
   - 逐个 `wrappedKey` 尝试 `unwrapKey`，全失败 → 该组消失；
   - 解密 meta → 校验 `{name, date}`（date 必须 `YYYY-MM-DD`）；
   - 解密照片；有 `encryptedCaption/ivCaption` 才解配文；
   - 组内按 `date` 升序稳定排序；
   - 一个 place 解密失败只丢该 place；整组为空则丢该组。
7. 一组都没解开 → `throw new Error('此信物不包含给你的内容')`。
8. `canAccept = structureOk && signatureOk && commitmentOk !== false`。

### 6.4 视图层 API（关键：不暴露组数）

```ts
interface UnpackedGroupView {
  groupId: string; places: UnpackedPlace[];
  fromName: string; fromPubkey: string; shareId: string;
  processed: boolean; // 由 UI 查本地边后回填
}
interface UnpackView {
  ok: true; groups: UnpackedGroupView[];
  from: { displayName: string; pubkey: string };
  shareId: string; commitment: string; signature: string;
  chainSeq: number; chainPrevHash: string;
  chainOk: boolean | null; chainNote: string;
  report: SafeReport; // 不含 errors（errors 里可能出现 groupId）
  canAccept: boolean;
}
interface UnpackFailure { ok: false; kind: 'old-version'|'not-for-you'|'invalid'; reason: string; }
```

`unpackForViewer` **不返回 pkg**，UI 因此无法计算 `groups.length`。
`reason` 不含组数/groupId；结构错误统一为"文件已损坏，或不是 TrailShare 信物"。

### 6.5 确定性边 ID（判重）

```
接受：`e_${shareId}_${groupId}_${placeId}`
拒绝：`e_${shareId}_${groupId}_rej`
```

同一文件重复导入时，已处理的组显示"已接受/已拒绝"，不会重复写记忆。
副作用：删除记忆会删掉边，之后可重新接受同一文件（已知局限）。

---

## 7. 算法

### 7.1 融合 `fuse(input)`

```
selfScore(tag) = Σ decay(daysSince(m.takenAt), halfLife)
                 for m.kind === 'self' && m.tag === tag

socialWeight(edge) =
  strategy === 'voting' ? 1
  : trust(fromPubkey) × decay(daysSince(anchor), halfLife)
    × (rejectedRatio > 0 ? max(0, 1 − 0.3 × rejectedRatio) : 1)
    × (strategy === 'verified' && edge.verified ? 1.2 : 1)

score(tag) = selfScore + Σ socialWeight(edge)  // edge.rejected 跳过；同一 edge.id 只算一次
```

- `trust(pubkey) = accepted / (accepted + rejected + 1)`。
- `anchor = memory.acceptedAt ?? edge.acceptedAt`。
- 只有 `memory.kind === 'gift'` 且能按 `edge.memoryId` 找到记忆的边才计入。
- 默认配置：`halfLifeDays=90, trustRejectedPenalty=0.3, verifiedBonus=1.2, strategy='verified'`。
- **`fuse.ts` 不允许为了评星改**；评星通过 `ratingAdapter` 在输入层处理（§7.6）。

### 7.2 排序

- `recommend(destinationTag, out, topK=3)`：排除目的地标签，按分数降序，平票按 `ALL_TAGS` 顺序。
- `rankTags(out, topK=3)`：**不排除任何标签**，只保留 `score>0`，用于反事实。
  反事实必须用它——否则被解释标签永远不参与比较，指标失真。

### 7.3 解释 `explain`

1. `extractTag(question)`：关键词表 → 六类标签；识别不到返回提示文本。
2. `buildExplanation(tag)`：
   - `citedEdgeIds` = `fuseOutput.contributions[tag].social` 中 `weight>0` 且存在于 `edges` 的边 id；
   - `citedMemoryIds` = 自己的、同 tag 的 self 记忆；
   - 文本：`你自己的照片里有 X 类记忆` / `你从 A、B 那里接受了 X 的分享 [gift:s_xxx] …`。
3. `explain()` 保持**同步纯函数**；LLM 版本另开 `explainWithLLM()`：
   - `parseQuery`（可选）→ 规则解释 → `paraphrase` → `selfCheck`；
   - 通过 → 用润色稿；不通过 → 重试 1 次；仍不过 → 规则稿 + `usedLLM=false`；
   - 没有引用边时不润色（没有编号可校验）；未配置 LLM 直接返回规则稿。
4. `selfCheck` 校验：多引（extra）、漏引（missing）、编造（fake）、空输出、JSON/代码块输出。
   回答里的 `[gift:s_xxx]` 与内部边 id 统一折算成 shareId 再比。

### 7.4 反事实 `faithfulness`

```
before = rankTags(fuse(fullInput), 3)
after  = rankTags(fuse({ ...input, edges: edges.filter(e => !cited.has(e.id)) }), 3)
flipped = JSON.stringify(before) !== JSON.stringify(after)
score = flipped ? 1 : 0
```

批量评测必须**每条都用完整输入**，不能累积移除。

### 7.5 多跳 `multihopDecay`

```
w_d = trust × decay × (verified ? 1.2 : 1) × 拒绝惩罚   // voting 策略下只看 decay
accumulated_d = Π_{i≤d} w_i
cost_i = |log(max(w_i, 1e-12))|
directShare_d = cost_d / Σ_{i≤d} cost_i
indirectShare_d = 1 − directShare_d
```

这是**启发式归因**，不是因果分解；README 与代码注释都必须标注。

### 7.6 评星适配 `ratingAdapter`

```
avg = mean(ratings.filter(非 null))；无评分 → null
avg === null || avg >= 3 → accepted；否则 rejected

ratingsToCounts(edges, memories)：已拒绝边计入 rejected；其余按对应记忆判定
adaptEdgesForFuse(edges, memories)：低分记忆的边 → { ...edge, rejected: true }
```

`tabLibrary` 把 `adaptEdgesForFuse` 的结果喂给 `fuse / explainWithLLM / faithfulness`。
**`fuse` 与实验输入都不变**，所以 E1–E4 数字不受评星影响。

---

## 8. UI

### 8.1 结构

Tab 顺序固定：**旅程 → 记忆库 → 生成信物 → 导入信物 → 好友**，默认落在「旅程」。
`tabs.ts` 维护 `TabName` 与 `onTabShow` 钩子；`main.ts` 渲染 SHELL 并挂载五个 panel。

### 8.2 旅程编辑器

- 列表：标题、封面（`coverPhotoOf`）、`N 天 · N 个地点 · N 张照片`、删除（二次确认）。
- 新建：`newTrip()` + 默认一天（今天），直接进编辑器。
- 编辑器：标题 input；每天一张卡（date input、地点数、删这天）；每个地点一张卡
  （名称、label、标签 select、三星强度、照片条、每张照片的配文 textarea、删地点）；
  「＋ 在这一天添加地点」「＋ 添加一天」。
- **自动保存**：所有输入改内存模型 → debounce 250ms `putTrip`。
  结构变化（增删、换封面、加照片）立即保存并整块重渲染；文本输入不重渲染（否则丢焦点）。
- 照片压缩：`compressImageBatch` 逐张串行，失败跳过；每地点上限 5 张。

### 8.3 生成页

- 选 Trip（默认第一个）；每组一张卡，含：
  - 时间线勾选树：Day → Place → Photo → Caption 四级；勾选 = 打包；
  - 父级取消勾选时子级 `disabled` 且半透明；子级状态保留；
  - 组头实时显示"给 N 人 · 可见 X 个地点 / Y 张照片"；
  - 收件人列表（"我自己" + 好友）；
- 「＋ 添加一组」= 复制组 1 的 Trip / 可见性（深拷贝，groupId 改写）/ 收件人；最多 3 组。
- 生成时：校验每组有可见内容与收件人 → `pack` → 写链记录 → 每个可见地点写一条 `kind='self'` 的 Memory → 下载 → 结果卡。

### 8.4 导入页

- 只调 `unpackForViewer`；失败只显示 `reason`，不显示任何包级信息。
- 每个解开的组：`来自：X` + 按日期分组的连续时间线；地点显示 `label · name`、
  `tag · 星星`、照片横滑、配文。
- 组级「接受这段旅程 / 拒绝」；处理过的组显示结果态。
- **任何位置不出现**：`共 N 组`、`共 N 天`、`共 N 个地点`、`第 N 组`、`还有 N 个`。
- 底部固定"传播边界"说明：能防/防不住各两条。

### 8.5 记忆库

- 时间线：按 `dayDate ?? takenAt.slice(0,10)` 分组，日期升序；一条 Memory = 一个地点卡。
- 每张照片下有 5 颗星：点击评分，点同一颗取消；显示"未评"或"N 星"。
- 点击照片打开同一 Memory 的轮播；卡片右上 × 删除（连带删除边，链不动，清空当前回答）。
- 搜索框 → `explainWithLLM` → 回答 + 引用清单 + 反事实按钮。

### 8.6 好友页

我的公钥 + 复制；手工添加（64 位 hex，可带前缀，自动派生 X25519）；列表 + 删除确认。
首次启动 `seedDemoFriends()`（`[测试]好友A/B/C`，固定种子，私钥公开）。

### 8.7 文案硬规则

- 导入页/记忆库不允许出现任何"总数暗示"，包括"还有 N 个"。
- 发送方页面可以显示组号（他自己知道有几组）；接收方页面不可以。
- 拒绝/接受是组级；评星是照片级。

---

## 9. 实验

`src/experiments/fixtures.ts` 固定 `NOW = 2026-10-18T12:00:00Z`，所有时间相对它写死。
`PK.A/B/C/D` 是 64 个重复字符的假公钥。

### 9.1 E1 隐私–可验证–效用

```
隐私分 = 0.4 × 内容隐藏 + 0.3 × (1 − 猜对率) + 0.3 × (1 − 侧信道泄露)
猜对率：18 种 (tag,intensity) 均匀猜测，seed=20261018，每组合 20000 次（≈5.56%）
```

| 粒度 | contentHidden | leakage | 可验证 | 效用 | 隐私 |
|---|---|---|---|---|---|
| plain | 0 | 1 | 1.00 | 1.00 | **0.000** |
| encrypted | 1 | 0.5 | 1.00 | 1.00 | **0.833** |
| commitment_only | 1 | 0 | 0.60 | 0.20 | **0.983** |

### 9.2 E2 反事实忠实度

- 场景 `buildE2Scenario()`：自己只有都市/美食；自然与人文贴身竞争；水乡注定不翻转。
- 对六个标签各问一句 → 只统计"至少引用一条边"的解释 → 逐条移除引用边看 top-3 是否变。
- 基线：总解释 6，可检验 6，**忠实 5，忠实度 0.833**。

### 9.3 E3 三策略消融

- 三个策略：`voting` / `trust` / `verified`；对六个目的地各取 top-1，比较是否变化。
- 主场景（自然分布）：**1/6**（负结果：验证加权通常不改变排名）。
- 贴身竞争场景（权重差 12%，一验一未验）：**4/6**。
- 两个场景必须同时报告。

### 9.4 E4 多跳

- 构造 A→B→C→D，三跳均 `verified`，接受时间分别 20/14/7 天前。
- 基线：第 3 跳累积权重 **15.8%**，间接份额 **69.4%**；第 2 跳间接份额 51.8%。
- 必须标注：样本为 1 条构造链，只能说明模型行为，不能外推。

### 9.5 回归基线（复刻必须一致）

| 实验 | 输出 |
|---|---|
| E1 | `0.000 / 0.833 / 0.983` |
| E2 | `0.833`（5/6） |
| E3 | `1/6` 与 `4/6` |
| E4 | `15.8%`（间接 69.4%） |

---

## 10. 测试

### 10.1 文件与用例数（共 204）

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `crypto.test.ts` | 34 | 密钥派生、canonical JSON、签名、AES、承诺、链 |
| `fuse.test.ts` | 16 | 三策略、衰减、信任、去重 |
| `counterfactual.test.ts` | 12 | 单条/批量、翻转判定 |
| `multihop.test.ts` | 8 | 权重、累积、归因 |
| `self_check.test.ts` | 14 | 多引/漏引/编造/空/JSON |
| `pack.test.ts` | 23 | v2026.4 往返、屏蔽、承诺、旧版本 |
| `directed.test.ts` | 12 | 定向隔离、篡改、链关闭、视图不暴露组数 |
| `filter.test.ts` | 9 | 四层过滤与顺序 |
| `commitment.test.ts` | 8 | 组织承诺排序/敏感性 |
| `photoList.test.ts` | 19 | 追加/去重/上限/封面（**legacy**：APP 已不引用，为对齐 204 保留；复刻若不在意用例数可删） |
| `store.test.ts` | 9 | 删除记忆连带边、链不动 |
| `trips.test.ts` | 13 | Trip CRUD / 统计 / 封面 |
| `visibility.test.ts` | 10 | 每组独立、withHidden |
| `ratings.test.ts` | 7 | 评分/取消/越界 |
| `ratingAdapter.test.ts` | 10 | 平均分映射、边改写 |

### 10.2 运行方式

```bash
npm test -- --no-file-parallelism   # 推荐：并行模式偶发 vitest 缓存 EPERM
```

`tests/*.test.ts` 里凡涉及 IndexedDB 的文件，首行必须有 `import 'fake-indexeddb/auto';`，
并在 `beforeEach` 清库（`clearAll()` 或 `clearTrips()`）。

### 10.3 必须覆盖的"不变量"

1. **屏蔽 = 不打包**：断言包结构里的 `places.length`，而不是只断言 UI。
2. **视图不暴露组数**：`'totalGroups' in view === false`、`'pkg' in view === false`。
3. **拒绝也落边**：`rejected: true`，`memoryId: ''`。
4. **链只追加**：删记忆后链记录数量与内容不变。
5. **fuse 不被评星污染**：实验输入没有 ratings，数字不变。
6. **旧版本必须抛固定文案**。

---

## 11. 实现路线（按顺序做，每步都有验收）

### M0 工程骨架
- `npm create vite`（vanilla-ts）→ 清理模板 → 配 `vite.config.ts` 的 vitest 段。
- 验收：`npm run dev` 出空白页，`npm test` 可跑（0 用例）。

### M1 类型与工具
- 写 `types.ts` 全量类型；`utils/{binary,base64,hash,id,time,trust}.ts`。
- 验收：`tsc --noEmit` 通过；`decay(90,90)=0.5`。

### M2 密码学
- `keys.ts`（Ed25519 + X25519 + 种子派生）→ `sign.ts`（canonical JSON）→
  `encrypt.ts`（AES-GCM + KEM）→ `commitment.ts` → `chain.ts`。
- 验收：`tests/crypto.test.ts` 全绿；ECDH 双方共享秘密一致；篡改密文解密失败。

### M3 分享协议
- `schema.ts` → `filter.ts` → `pack.ts` → `unpack.ts`（含 `unpackForViewer`）。
- 验收：`tests/filter/pack/directed/commitment` 全绿；包内 `places` 数量随屏蔽变化。

### M4 存储
- 主库 → trips/visibility → ratings → friends。
- 验收：`tests/{store,trips,visibility,ratings}` 全绿；刷新后 Trip 还在。

### M5 Agent 算法
- `fuse` → `recommend` → `explain` → `counterfactual` → `multihop` → `ratingAdapter`。
- 验收：`tests/{fuse,counterfactual,multihop}` 全绿；E2 出 0.833。

### M6 实验
- `fixtures.ts`（严格照 §9 的时间与数据）→ E1–E4 → `run_all`。
- 验收：四个数字与 §9.5 逐位一致。**这一步不过，不要写 UI。**

### M7 UI
- `main/tabs` → `tripList/tripEditor` → `tabCreate`（可见性树）→ `tabImport`（时间线）→
  `tabLibrary`（时间线 + 评星）→ `tabFriends`。
- 验收：手动跑通"建 Trip → 屏蔽一天 → 发给 B → B 只看到剩余天 → 接受 → 评星"。

### M8 加固与文档
- 版本闸门、错误文案、空态、二次确认、移动端断点。
- README / QUICKSTART / 本文件；`npm pack` 检查。
- 验收：`npm test` 204、`npm run build`、四个实验一致。

---

## 12. 复刻验收清单

```bash
# 1. 类型与测试
npx tsc --noEmit
npm test -- --no-file-parallelism          # 204 passed

# 2. 构建
npm run build                              # dist 生成

# 3. 实验（逐位比对）
npx tsx src/experiments/e1_privacy.ts      # 0.000 / 0.833 / 0.983
npx tsx src/experiments/e2_faithfulness.ts # 0.833
npx tsx src/experiments/e3_ablation.ts     # 1/6、4/6
npx tsx src/experiments/e4_multihop.ts     # 15.8%

# 4. 手工
# 建 2 天 Trip → 生成时取消 Day2 → B 导入只看到 Day1，页面无"共 N 天/组"
# B 接受 → 评 5 星 → 再点取消 → 问 Agent → 反事实翻转
# A 非收件人导入 → "不是给你的"
# 导入 v2026.3 文件 → "版本过旧"
```

判定：以上全部通过，且**没有为了让数字对上而修改实验脚本**，才算复刻完成。

---

## 13. 已知坑与决策记录（复刻时最容易踩）

1. **反事实必须用 `rankTags`，不能用 `recommend`**：`recommend(destination)` 会把被解释标签排除，
   导致它自己的分数永远不参与比较，忠实度几乎恒判不翻转。
2. **`unpack()` 与 `unpackForViewer()` 双接口**：前者服务算法/测试（含 `pkg/report`），
   后者服务 UI（不含 pkg）。合并会让"界面不暴露组数"失效。
3. **`ed25519.utils.toMontgomerySecret(seed)` 的输入是种子，不是私钥哈希**：noble 内部已做 clamp。
4. **签名对象必须过滤 `undefined` 并按 key 排序**：否则 A/B 两端的 JSON 字节不同，验签随机失败。
5. **`chain.prevHash` 比较前要 `stripAlgo`**：读写路径混用 `sha256:` 前缀会判链断。
6. **可信新朋友 trust 为 0**：`accepted/(accepted+rejected+1)`，必须至少接受过一次。
7. **E3 主场景是负结果**：验证加权只在贴身竞争时改变排名，不要为了让"变化率"好看而调场景。
8. **E4 的间接份额是启发式归因**：换权重就会变，报告里必须标注"非因果"。
9. **屏蔽要在 pack 之前过滤**：先打包再隐藏会留下"存在但不可见"的痕迹。
10. **一个地点零可见照片就整条不打包**：否则会出现空地点卡。
11. **`takenAt` 用当天中午**：00:00 在东八区会退到前一天。
12. **`Memory.photos` 类型上可选**：实验 fixtures 只用 `thumbBlob`，设成必填会让 `tsc` 直接红。
13. **评星不要改 `fuse.ts`**：用 `ratingAdapter` 在输入层把低分边标 `rejected`。
14. **`npm test` 并行偶发 EPERM**：vitest 写缓存撞沙箱，串行稳定。
15. **`VITE_` 变量会被打进前端产物**：LLM Key 只适合本地演示，生产必须走服务端代理。
16. **旧版本没有兼容层**：v2026.3 的 group 只有一个 tag，硬转会把时间线压扁。
17. **`localStorage` 在无痕/隐私模式可能不可写**：读写都要 try/catch。
18. **`file://` 下 IndexedDB 与 WebCrypto 不可用**：启动失败页要给出这个提示。
19. **同一浏览器进程的第二次自动下载可能被拦**：演示时准备好"重新下载"按钮。
20. **`package-lock.json` 不会进 `npm pack`**：要锁版本请直接发仓库压缩包。

---

## 14. 可选：LLM 润色（不影响复刻判定）

`.env.example`：

```
VITE_LLM_BASE_URL=https://api.deepseek.com/v1
VITE_LLM_API_KEY=
VITE_LLM_MODEL=deepseek-chat
```

- 未配置 → 全部走规则版，功能完整。
- 客户端：10s 超时、失败重试 1 次、连续 2 次失败熔断 60s。
- 润色 prompt 必须写死四条：不新增引用、不删除引用、不改编号、不编造事实。
- 润色后必须 `selfCheck`；不过则重试一次，再不过退回规则稿并标"规则版回答"。
- **LLM 永远不参与排序、选源、反事实**。

---

## 15. 打包分发

```bash
npm pack                       # trailshare-0.2.0.tgz
tar -xzf trailshare-0.2.0.tgz && cd package && npm install && npm run dev
```

`package.json` 的 `files` 必须包含 `src/`、`tests/`、`public/`、`index.html`、配置、
`README.md`、`QUICKSTART.md`、`.env.example`、`.gitignore`。`node_modules/`、`dist/`、
`.env.local` 不得进包。`npm pack` 不会带 `package-lock.json`（npm 固定行为）。

三窗口演示时提醒接收方：**两个无痕窗口必须独立开**（Ctrl+Shift+N 两次），
同一个无痕窗口的两个标签共享 IndexedDB，等于同一个人。

---

## 附：一句话检查清单

> 六类标签、三种强度；一份种子两套密钥；AES-GCM 每张独立 IV；KEM 每人一条；
> 承诺只覆盖可见 place 的 tag/intensity + 盐；屏蔽即不打包；界面从不报总数；
> 解释必须带 shareId；反事实用全标签榜；评星走适配层不改 fuse；链可关；旧包拒绝。
