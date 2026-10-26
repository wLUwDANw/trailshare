/**
 * L0 本地哈希链。纯函数：时间必须显式传入，保证可复现。
 *
 * 链在这里不是科研贡献，是使能技术：它只回答"这条信物在本地账本里是连续插入的，
 * 不是凭空冒出来的"。链失效不影响主流程（chain_enabled=false 时 anchor 恒为 null）。
 */
import { sha256Utf8, stripAlgo } from '../utils/hash';
import type { ChainRecord } from '../types';

export const GENESIS_HASH = '0'.repeat(64);

export type ChainEvent = ChainRecord['event'];

/** hash = SHA256(shareId || sig || prevHash || seq) */
export function chainHash(shareId: string, sig: string, prevHash: string, seq: number): string {
  return sha256Utf8(`${shareId}||${sig}||${stripAlgo(prevHash)}||${seq}`);
}

export function appendChain(
  prev: ChainRecord | null,
  event: ChainEvent,
  refId: string,
  sig: string,
  ts: string,
): ChainRecord {
  const seq = prev ? prev.seq + 1 : 0;
  const prevHash = prev ? prev.hash : GENESIS_HASH;
  return {
    seq,
    hash: chainHash(refId, sig, prevHash, seq),
    prevHash,
    event,
    refId,
    ts,
  };
}

/**
 * 校验本地链的连接性：seq 连续、prevHash 指向上一条的 hash、首条指向 GENESIS。
 * 只做连接性检查（不需要 sig）；具体的 hash 值可用 verifyRecordHash 复核。
 */
export function verifyChainLink(records: ChainRecord[]): { ok: boolean; brokenAt: number | null } {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  let prev: ChainRecord | null = null;
  for (const rec of sorted) {
    if (!prev) {
      if (rec.seq !== 0) return { ok: false, brokenAt: rec.seq };
      if (rec.prevHash !== GENESIS_HASH) return { ok: false, brokenAt: rec.seq };
    } else {
      if (rec.seq !== prev.seq + 1) return { ok: false, brokenAt: rec.seq };
      if (rec.prevHash !== prev.hash) return { ok: false, brokenAt: rec.seq };
    }
    prev = rec;
  }
  return { ok: true, brokenAt: null };
}

/** 用信物的签名复核某条链记录的 hash 是否真的由该内容算出。 */
export function verifyRecordHash(record: ChainRecord, sig: string): boolean {
  return record.hash === chainHash(record.refId, sig, record.prevHash, record.seq);
}

/** 链上"这个 prevHash 之前是否见过"——用于判断信物是否插入到既有链之后。 */
export function hasHash(records: ChainRecord[], hash: string, excludeSeq?: number): boolean {
  const target = stripAlgo(hash);
  return records.some((r) => r.hash === target && r.seq !== excludeSeq);
}
