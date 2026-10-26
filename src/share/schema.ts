/** 分享包格式常量与小工具。改协议版本必须同步改这里。 */
import type { ShareVersion } from '../types';

export const SHARE_VERSION: ShareVersion = 'ts-2026.4';

/** 旧版本前缀。命中它但不等于当前版本 → 直接拒绝并提示重新生成。 */
export const LEGACY_VERSION_PREFIX = 'ts-2026.';

export const SIG_PREFIX = 'ed25519:';

/** 一个信物最多带几张照片（每组）。超过建议拆分成多个信物。 */
export const MAX_PHOTOS = 5;
export const MIN_PHOTOS = 1;

/** 一次信物最多带几组（每组面向不同的接收方集合）。 */
export const MAX_GROUPS = 3;

/** 只接受当前版本；旧版本由 unpack 抛出可读错误。 */
export function isShareVersion(v: string): boolean {
  return v === SHARE_VERSION;
}

/** 形如 ts-2026.<n> 的版本号，抽出 n；不是这个形状返回 null。 */
export function versionMinor(v: string): number | null {
  if (!v.startsWith(LEGACY_VERSION_PREFIX)) return null;
  const rest = v.slice(LEGACY_VERSION_PREFIX.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}
