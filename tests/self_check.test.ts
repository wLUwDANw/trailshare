import { describe, expect, it } from 'vitest';
import { selfCheck, extractGiftIds, looksLikeStructured } from '../src/agent/self_check';
import type { ProvenanceEdge } from '../src/types';

/** 构造一条最小可用的溯源边。selfCheck 只关心 id / shareId。 */
function edge(id: string, shareId: string): ProvenanceEdge {
  return {
    id,
    memoryId: `m_${id}`,
    shareId,
    fromPubkey: 'a'.repeat(64),
    fromName: 'A',
    commitment: 'sha256:' + '0'.repeat(64),
    signature: 'ed25519:' + '0'.repeat(64),
    chainAnchor: null,
    verified: true,
    acceptedAt: '2026-10-18T00:00:00.000Z',
  };
}

const EDGES: ProvenanceEdge[] = [edge('e1', 's_a1'), edge('e2', 's_b1'), edge('e3', 's_c1')];
const EXPECTED = ['e1', 'e2'];

const ruleAnswer =
  '你自己的照片里有自然风光类记忆，你从A、B那里接受了自然风光的分享 [gift:s_a1] [gift:s_b1]。';

describe('extractGiftIds', () => {
  it('按出现顺序提取并去重', () => {
    expect(extractGiftIds('[gift:s_a1] 中间文字 [gift:s_b1] 再来一次 [gift:s_a1]')).toEqual([
      's_a1',
      's_b1',
    ]);
  });

  it('没有标记时返回空数组', () => {
    expect(extractGiftIds('今天天气不错')).toEqual([]);
    expect(extractGiftIds('')).toEqual([]);
  });

  it('能识别被 JSON/代码块包裹的输出', () => {
    expect(looksLikeStructured('{"answer":"x"}')).toBe(true);
    expect(looksLikeStructured('```json\n{}\n```')).toBe(true);
    expect(looksLikeStructured('你从 A 那里接受过分享 [gift:s_a1]。')).toBe(false);
  });
});

describe('selfCheck · 引用一致性', () => {
  it('引用集合完全一致 → passed', () => {
    const result = selfCheck(ruleAnswer, EXPECTED, EDGES);
    expect(result.passed).toBe(true);
    expect(result.extraIds).toEqual([]);
    expect(result.missingIds).toEqual([]);
    expect(result.fakeIds).toEqual([]);
    expect(result.reason).toBeUndefined();
  });

  it('多引用一条真实存在的边 → extraIds 非空，failed', () => {
    const llm = ruleAnswer.replace('。', '，还有 [gift:s_c1]。');
    const result = selfCheck(llm, EXPECTED, EDGES);
    expect(result.passed).toBe(false);
    expect(result.extraIds).toContain('s_c1');
    expect(result.missingIds).toEqual([]);
    expect(result.fakeIds).toEqual([]);
    expect(result.reason).toContain('多引用');
  });

  it('漏引用一条边 → missingIds 非空，failed', () => {
    const llm = '你自己的照片里有自然风光类记忆，你从A那里接受了分享 [gift:s_a1]。';
    const result = selfCheck(llm, EXPECTED, EDGES);
    expect(result.passed).toBe(false);
    expect(result.missingIds).toContain('s_b1');
    expect(result.extraIds).toEqual([]);
    expect(result.fakeIds).toEqual([]);
    expect(result.reason).toContain('漏引用');
  });

  it('编造库里不存在的边 ID → fakeIds 非空，failed', () => {
    const llm = ruleAnswer.replace('。', '，还有 [gift:s_totally_fake]。');
    const result = selfCheck(llm, EXPECTED, EDGES);
    expect(result.passed).toBe(false);
    expect(result.fakeIds).toContain('s_totally_fake');
    // 编造的不算"多引用"，避免同一条被报两次
    expect(result.extraIds).toEqual([]);
    expect(result.reason).toContain('不存在的来源');
  });

  it('输出里没有任何 [gift:] 但期望非空 → missingIds 非空，failed', () => {
    const llm = '你从朋友那里接受过自然风光的分享，所以推荐你去。';
    const result = selfCheck(llm, EXPECTED, EDGES);
    expect(result.passed).toBe(false);
    expect(result.missingIds.length).toBe(2);
    expect(result.reason).toContain('没有任何 [gift:');
  });

  it('输出是 JSON / 代码块 → 当作格式错误，failed', () => {
    const llm = '{"answer":"推荐自然风光","citations":["s_a1","s_b1"]}';
    const result = selfCheck(llm, EXPECTED, EDGES);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('JSON');
    expect(extractGiftIds(llm)).toEqual([]);
  });

  it('输出为空 → failed，并把期望的引用全部记为漏引', () => {
    const result = selfCheck('   ', EXPECTED, EDGES);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('LLM 输出为空');
    expect(result.missingIds.length).toBe(2);
  });

  it('同一编号重复出现只算一次', () => {
    const llm = '[gift:s_a1] [gift:s_a1] 你从B那里也收到过 [gift:s_b1]';
    const result = selfCheck(llm, EXPECTED, EDGES);
    expect(result.passed).toBe(true);
    expect(result.extraIds).toEqual([]);
  });

  it('边 ID 与 shareId 混用也能对上（统一折算成 shareId）', () => {
    const llm = '你从 A 那里接受过 [gift:e1]，从 B 那里接受过 [gift:s_b1]。';
    const result = selfCheck(llm, EXPECTED, EDGES);
    expect(result.passed).toBe(true);
  });

  it('期望为空且输出没有引用 → passed（没有可校验的编号）', () => {
    const result = selfCheck('你自己的照片里有自然风光类记忆。', [], EDGES);
    expect(result.passed).toBe(true);
    expect(result.missingIds).toEqual([]);
  });

  it('多引、漏引、编造同时出现时，三类都能报出来', () => {
    const llm = '只有 [gift:s_a1]，另外 [gift:s_c1] 和 [gift:s_ghost]。';
    const result = selfCheck(llm, EXPECTED, EDGES);
    expect(result.passed).toBe(false);
    expect(result.missingIds).toEqual(['s_b1']);
    expect(result.extraIds).toEqual(['s_c1']);
    expect(result.fakeIds).toEqual(['s_ghost']);
  });
});
