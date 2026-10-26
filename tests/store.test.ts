// IndexedDB 在 Node 里由 fake-indexeddb 提供（必须最先 import，确保 db.ts 用的是它）
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';
import { clearAll } from '../src/store/db';
import { deleteMemory, listMemories, putMemory } from '../src/store/memories';
import { deleteEdgesByMemoryId, listEdges, putEdge } from '../src/store/provenance';
import { appendChainRecord, listChain } from '../src/store/chainStore';
import { fuse, DEFAULT_FUSE_CONFIG } from '../src/agent/fuse';
import { explain } from '../src/agent/explain';
import type { Memory, ProvenanceEdge, Tag } from '../src/types';

const NOW = new Date('2026-10-18T12:00:00Z');
const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

function memory(
  id: string,
  opts: { kind?: 'self' | 'gift'; tag?: Tag; fromName?: string; fromPubkey?: string } = {},
): Memory {
  const kind = opts.kind ?? 'gift';
  const base: Memory = {
    id,
    kind,
    photos: [],
    coverIndex: 0,
    tag: opts.tag ?? 'nature',
    intensity: 'high',
    takenAt: '2026-10-01T00:00:00.000Z',
  };
  if (kind === 'gift') {
    base.fromName = opts.fromName ?? 'A';
    base.fromPubkey = opts.fromPubkey ?? PK_A;
    base.shareId = `s_${id}`;
    base.acceptedAt = '2026-10-02T00:00:00.000Z';
  }
  return base;
}

function edgeOf(id: string, memoryId: string, fromName = 'A', fromPubkey = PK_A): ProvenanceEdge {
  return {
    id,
    memoryId,
    shareId: `s_${memoryId}`,
    fromPubkey,
    fromName,
    commitment: 'sha256:' + '0'.repeat(64),
    signature: 'ed25519:' + '0'.repeat(64),
    chainAnchor: null,
    verified: true,
    acceptedAt: '2026-10-02T00:00:00.000Z',
  };
}

beforeEach(async () => {
  await clearAll();
});

describe('deleteEdgesByMemoryId', () => {
  it('返回删除的边数量', async () => {
    await putEdge(edgeOf('e1', 'm1'));
    await putEdge(edgeOf('e2', 'm1'));
    await putEdge(edgeOf('e3', 'm2'));
    const removed = await deleteEdgesByMemoryId('m1');
    expect(removed).toBe(2);
    expect((await listEdges()).map((e) => e.id)).toEqual(['e3']);
  });

  it('幂等：再删一次返回 0，不报错', async () => {
    await putEdge(edgeOf('e1', 'm1', 'A', PK_A));
    expect(await deleteEdgesByMemoryId('m1')).toBe(1);
    expect(await deleteEdgesByMemoryId('m1')).toBe(0);
  });

  it('没有任何关联边时返回 0', async () => {
    expect(await deleteEdgesByMemoryId('nobody')).toBe(0);
  });
});

describe('deleteMemory', () => {
  it('删除记忆本身与它的溯源边', async () => {
    await putMemory(memory('m1'));
    await putEdge(edgeOf('e1', 'm1'));

    await deleteMemory('m1');

    expect((await listMemories()).find((m) => m.id === 'm1')).toBeUndefined();
    expect(await listEdges()).toHaveLength(0);
  });

  it('不会误删其它记忆的边', async () => {
    await putMemory(memory('m1'));
    await putMemory(memory('m2', { fromName: 'B', fromPubkey: PK_B }));
    await putEdge(edgeOf('e1', 'm1'));
    await putEdge(edgeOf('e2', 'm2', 'B', PK_B));

    await deleteMemory('m1');

    const left = await listEdges();
    expect(left.map((e) => e.id)).toEqual(['e2']);
    expect(left[0].memoryId).toBe('m2');
  });

  it('listMemories 之后不再返回该条', async () => {
    await putMemory(memory('m1'));
    await putMemory(memory('m2', { fromName: 'B', fromPubkey: PK_B }));
    await deleteMemory('m1');
    const ids = (await listMemories()).map((m) => m.id);
    expect(ids).toEqual(['m2']);
  });

  it('链记录数量与内容都不变（链只追加）', async () => {
    await appendChainRecord('share_created', 's_x', 'ed25519:aa', '2026-10-01T00:00:00.000Z');
    await appendChainRecord('share_accepted', 's_y', 'ed25519:bb', '2026-10-01T00:00:01.000Z');
    const before = await listChain();

    await putMemory(memory('m1'));
    await putEdge(edgeOf('e1', 'm1'));
    await deleteMemory('m1');

    const after = await listChain();
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.hash)).toEqual(before.map((r) => r.hash));
  });

  it('删除不存在的 memoryId 不报错', async () => {
    await expect(deleteMemory('ghost')).resolves.toBeUndefined();
    await putMemory(memory('m1'));
    await expect(deleteMemory('ghost')).resolves.toBeUndefined();
    expect(await listMemories()).toHaveLength(1);
  });
});

describe('删除后的解释链路', () => {
  it('explain() 不再引用已删除记忆对应的边', async () => {
    const m1 = memory('m1', { fromName: 'A', fromPubkey: PK_A });
    const m2 = memory('m2', { fromName: 'B', fromPubkey: PK_B });
    await putMemory(m1);
    await putMemory(m2);
    const e1 = edgeOf('e1', 'm1', 'A', PK_A);
    const e2 = edgeOf('e2', 'm2', 'B', PK_B);
    await putEdge(e1);
    await putEdge(e2);

    // 删除前：两条边都被引用
    const before = fuse({ memories: [m1, m2], edges: [e1, e2], now: NOW, config: DEFAULT_FUSE_CONFIG });
    const expBefore = explain('为什么推荐自然风光？', before, [m1, m2], [e1, e2]);
    expect(expBefore.citedEdgeIds).toContain('e1');
    expect(expBefore.citedEdgeIds).toContain('e2');

    await deleteMemory('m1');

    // 删除后：用库里剩下的数据重新算，e1 不再出现
    const memories = await listMemories();
    const edges = await listEdges();
    const after = fuse({ memories, edges, now: NOW, config: DEFAULT_FUSE_CONFIG });
    const expAfter = explain('为什么推荐自然风光？', after, memories, edges);

    expect(expAfter.citedEdgeIds).toEqual(['e2']);
    expect(expAfter.citedEdgeIds).not.toContain('e1');
    expect(expAfter.answer).not.toContain('s_m1');
  });
});
