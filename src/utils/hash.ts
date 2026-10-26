/**
 * SHA256 便捷封装。纯函数：无 IO、无 crypto.subtle，Node 里可直接 import。
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function sha256Utf8(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}

/** 规范化哈希字符串：统一 `sha256:<hex>` 形式，便于包内自描述。 */
export function withAlgo(hex: string): string {
  return hex.startsWith('sha256:') ? hex : `sha256:${hex}`;
}

export function stripAlgo(value: string): string {
  const idx = value.indexOf(':');
  return idx === -1 ? value : value.slice(idx + 1);
}
