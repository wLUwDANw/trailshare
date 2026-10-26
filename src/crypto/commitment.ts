/**
 * 语义承诺（commitment）。纯函数：无 IO、无 crypto.subtle。
 *
 * 承诺 = SHA256(tag || salt || intensity)
 *
 * 为什么强度只进承诺、不进明文：
 * - 承诺单向不可逆，攻击者拿到哈希也算不出 1~10 分；
 * - 盐每次随机，相同偏好每次产生不同承诺，防止"同一偏好 = 同一指纹"的关联攻击；
 * - 接收方在看不到强度的前提下，仍能验证"承诺本身没被中间人替换"。
 */
import { sha256Utf8, withAlgo, stripAlgo } from '../utils/hash';
import type { IntensityBucket, MetaPlain, Tag } from '../types';

export const COMMITMENT_ALGO = 'sha256' as const;

/** 用分隔符拼接，避免 `tag='nature', salt='ab'` 与 `tag='naturea', salt='b'` 撞车。 */
export function commitmentInput(tag: Tag, saltB64: string, intensity: IntensityBucket): string {
  return `${tag}||${saltB64}||${intensity}`;
}

/** 返回不带算法前缀的 hex，便于直接放进 `commitment.hash` 的 `sha256:` 之后。 */
export function commitmentHex(tag: Tag, saltB64: string, intensity: IntensityBucket): string {
  return sha256Utf8(commitmentInput(tag, saltB64, intensity));
}

/** 返回 `sha256:<hex>`，即分享包里的标准写法。 */
export function commitmentValue(tag: Tag, saltB64: string, intensity: IntensityBucket): string {
  return withAlgo(commitmentHex(tag, saltB64, intensity));
}

export function commitmentFromMeta(meta: MetaPlain, saltB64: string): string {
  return commitmentValue(meta.tag, saltB64, meta.intensity);
}

/** 常数时间比较，避免通过响应时间区分"前缀对了几位"。 */
export function verifyCommitment(
  expected: string,
  tag: Tag,
  saltB64: string,
  intensity: IntensityBucket,
): boolean {
  const a = stripAlgo(expected).toLowerCase();
  const b = commitmentHex(tag, saltB64, intensity).toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * 多组承诺（MD-3）
 *
 * 新格式一次可以带多组。承诺必须同时覆盖"有哪些组、每组是什么语义"，
 * 否则攻击者可以把组 2 的 tag 换掉而不被发现。
 *
 * 规范（按 groupId 字典序，实现与文档必须一致）：
 *   sorted  = groups.sort(by groupId)
 *   meta    = sorted.map(g => `${g.groupId}||${g.tag}||${g.intensity}`).join('##')
 *   salts   = sorted.map(g => g.salt).join('##')
 *   input   = `${meta}##salt##${salts}`
 *   hash    = SHA256(input)
 *
 * 为什么要把盐也拼进去：盐是每组独立的随机数，混进承诺后，
 * 换组、换序、换盐都会改哈希；同时盐本身是公开的，任何人可复算。
 * ------------------------------------------------------------------ */

export interface GroupCommitmentInput {
  groupId: string;
  tag: Tag;
  intensity: IntensityBucket;
  saltB64: string;
}

function sortByGroupId<T extends { groupId: string }>(groups: T[]): T[] {
  return [...groups].sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0));
}

export function groupCommitmentInput(groups: GroupCommitmentInput[]): string {
  const sorted = sortByGroupId(groups);
  const meta = sorted.map((g) => `${g.groupId}||${g.tag}||${g.intensity}`).join('##');
  const salts = sorted.map((g) => g.saltB64).join('##');
  return `${meta}##salt##${salts}`;
}

export function groupCommitmentValue(groups: GroupCommitmentInput[]): string {
  return withAlgo(sha256Utf8(groupCommitmentInput(groups)));
}

export function verifyGroupCommitment(expected: string, groups: GroupCommitmentInput[]): boolean {
  const a = stripAlgo(expected).toLowerCase();
  const b = sha256Utf8(groupCommitmentInput(groups)).toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * v2026.4 · 组织承诺（一个 group 里多个 place）
 *
 * 规范（实现与文档必须一致）：
 *   groupPart(g) = [g.groupId, g.saltB64,
 *                   ...g.places.sort(by placeId).flatMap(p => [p.placeId, p.tag, p.intensity])
 *                  ].join('||')
 *   input        = groups.sort(by groupId).map(groupPart).join('||')
 *   hash         = SHA256(input)
 *
 * 覆盖的是「可见 place 的 (placeId, tag, intensity) 有序列表」+ 每组盐。
 * 日期 / 地点名 / 配文都在密文里，不进承诺——不持钥的人验证不了看不见的东西。
 * 被屏蔽的 place 不打包，因此也不在承诺里：屏蔽与承诺天然一致。
 * ------------------------------------------------------------------ */

export interface PlaceCommitmentInput {
  placeId: string;
  tag: Tag;
  intensity: IntensityBucket;
}

export interface GroupPlacesCommitmentInput {
  groupId: string;
  saltB64: string;
  places: PlaceCommitmentInput[];
}

function groupPlacesPart(group: GroupPlacesCommitmentInput): string {
  const places = [...group.places]
    .sort((a, b) => (a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0))
    .map((p) => `${p.placeId}||${p.tag}||${p.intensity}`)
    .join('||');
  return `${group.groupId}||${group.saltB64}||${places}`;
}

export function groupPlacesCommitmentInput(groups: GroupPlacesCommitmentInput[]): string {
  return [...groups]
    .sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0))
    .map(groupPlacesPart)
    .join('||');
}

export function groupPlacesCommitmentValue(groups: GroupPlacesCommitmentInput[]): string {
  return withAlgo(sha256Utf8(groupPlacesCommitmentInput(groups)));
}

export function verifyGroupPlacesCommitment(
  expected: string,
  groups: GroupPlacesCommitmentInput[],
): boolean {
  const a = stripAlgo(expected).toLowerCase();
  const b = sha256Utf8(groupPlacesCommitmentInput(groups)).toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
