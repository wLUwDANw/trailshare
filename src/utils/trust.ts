/**
 * 信任分数。纯函数。
 *
 * 设计要点：分母 +1 既避免除零，又让"从没接受过任何信物"的新朋友信任为 0。
 * 也就是说，必须至少接受过一次，才算"可信"。
 */
import type { ProvenanceEdge } from '../types';

export interface TrustStats {
  accepted: number;
  rejected: number;
  trust: number;
}

export function trustStats(pubkey: string, allEdges: ProvenanceEdge[]): TrustStats {
  let accepted = 0;
  let rejected = 0;
  for (const e of allEdges) {
    if (e.fromPubkey !== pubkey) continue;
    if (e.rejected) rejected += 1;
    else accepted += 1;
  }
  return { accepted, rejected, trust: accepted / (accepted + rejected + 1) };
}

export function trust(pubkey: string, allEdges: ProvenanceEdge[]): number {
  return trustStats(pubkey, allEdges).trust;
}
