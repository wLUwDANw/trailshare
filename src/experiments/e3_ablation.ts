/**
 * E3 · 社会边消融（三策略对比）。
 *
 * 对每个"目的地"，分别用 A 投票 / B 信任加权 / C 验证加权跑一遍推荐，
 * 看 top-1 是否不同、分差有多大。
 *
 * 两个场景缺一不可：
 * - 主场景（自然分布）：验证加权基本不改变结果 —— 因为它把所有已验证边同比例放大，
 *   排名通常不动。这是一个**负结果**，必须写进报告。
 * - 贴身竞争场景：两条边权重只差 12%，一条已验证一条没有 —— 此时验证加权才会翻盘。
 *   这说明"验证加成"只在近身竞争时起作用，不是万能药。
 */
import { fuse } from '../agent/fuse';
import { recommend } from '../agent/recommend';
import { ALL_TAGS, TAG_LABELS } from '../types';
import type { FuseConfig, Tag } from '../types';
import { buildScenario, buildTightScenario, type Scenario } from './fixtures';

export interface E3Row {
  destination: Tag;
  voting: Tag;
  trust: Tag;
  verified: Tag;
  changed: boolean;
  gap: { voting: number; trust: number; verified: number };
}

export interface E3Block {
  key: string;
  name: string;
  rows: E3Row[];
  changedCount: number;
  table: string;
  scoreTable: string;
}

export interface E3Result {
  main: E3Block;
  tight: E3Block;
  table: string;
  summary: string;
}

const STRATEGIES: FuseConfig['strategy'][] = ['voting', 'trust', 'verified'];

function runScenario(key: string, name: string, scenario: Scenario): E3Block {
  const rows: E3Row[] = ALL_TAGS.map((destination) => {
    const picks = STRATEGIES.map((strategy) => {
      const output = fuse({ ...scenario.input, config: { ...scenario.input.config, strategy } });
      const top = recommend(destination, output, 1)[0];
      return { tag: top.tag, score: top.score };
    });

    return {
      destination,
      voting: picks[0].tag,
      trust: picks[1].tag,
      verified: picks[2].tag,
      changed: new Set([picks[0].tag, picks[1].tag, picks[2].tag]).size > 1,
      gap: { voting: picks[0].score, trust: picks[1].score, verified: picks[2].score },
    };
  });

  const lines: string[] = [];
  lines.push(`### ${name}\n`);
  lines.push('| 目的地 | A 简单投票 | B 信任加权 | C 验证加权 | 结果是否变化 |');
  lines.push('|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(
      `| ${TAG_LABELS[r.destination]} | ${TAG_LABELS[r.voting]} | ${TAG_LABELS[r.trust]} | ${TAG_LABELS[r.verified]} | ${r.changed ? '是' : '否'} |`,
    );
  }

  const scoreLines: string[] = [];
  scoreLines.push('| 目的地 | A top-1 得分 | B top-1 得分 | C top-1 得分 |');
  scoreLines.push('|---|---|---|---|');
  for (const r of rows) {
    scoreLines.push(
      `| ${TAG_LABELS[r.destination]} | ${r.gap.voting.toFixed(3)} | ${r.gap.trust.toFixed(3)} | ${r.gap.verified.toFixed(3)} |`,
    );
  }

  return {
    key,
    name,
    rows,
    changedCount: rows.filter((r) => r.changed).length,
    table: lines.join('\n'),
    scoreTable: scoreLines.join('\n'),
  };
}

export function runE3(): E3Result {
  const main = runScenario('main', 'E3-a 主场景（自然分布）', buildScenario());
  const tight = runScenario('tight', 'E3-b 贴身竞争场景（权重差 12%，一验一未验）', buildTightScenario());

  const table = [
    main.table,
    '',
    `共 ${main.rows.length} 个目的地，${main.changedCount} 个在三种策略下 top-1 不同。`,
    '',
    main.scoreTable,
    '',
    tight.table,
    '',
    `共 ${tight.rows.length} 个目的地，${tight.changedCount} 个在三种策略下 top-1 不同。`,
    '',
    tight.scoreTable,
  ].join('\n');

  const summary = [
    `主场景变化率：${main.changedCount}/${main.rows.length}`,
    `贴身竞争场景变化率：${tight.changedCount}/${tight.rows.length}`,
    '结论：验证加成不是万能药——它只在两条证据权重接近时改变排名；',
    '在自然分布下，社会边常常被个人记忆压过，此时 A/B/C 三策略给出相同 top-1。',
  ].join('\n');

  return { main, tight, table, summary };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('e3_ablation.ts');
if (isMain) {
  const r = runE3();
  console.log('E3 · 社会边消融：三策略推荐对比\n');
  console.log(r.table);
  console.log('');
  console.log(r.summary);
}
