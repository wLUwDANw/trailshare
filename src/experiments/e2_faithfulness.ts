/**
 * E2 · 反事实忠实度。
 *
 * 对每个语义标签问一句"为什么推荐 X"，让 explain() 生成带引用边 id 的回答，
 * 再逐条移除它引用的边，看 top-3 排行榜是否翻转。
 *
 * 方法学说明（写报告时必须带上）：
 * - 只统计"可检验解释"（至少引用了一条边的）。没有引用的解释无从移除，不应计入分母。
 * - 单边必要性检验会低估解释质量：当个人记忆已经主导时，移除某条社会边不会翻转 top-3，
 *   这条解释会被判为 0 分，但它其实是"部分真实"的。E2 会把这类情况单独列出。
 */
import { explain } from '../agent/explain';
import { faithfulnessBatch } from '../agent/counterfactual';
import { fuse } from '../agent/fuse';
import { ALL_TAGS, TAG_LABELS } from '../types';
import { buildE2Scenario } from './fixtures';

export interface E2Detail {
  question: string;
  tag: string;
  cited: number;
  before: string[];
  after: string[];
  flipped: boolean;
}

export interface E2Result {
  total: number;
  testable: number;
  skipped: number;
  faithful: number;
  rate: number;
  details: E2Detail[];
  table: string;
  summary: string;
}

export function runE2(): E2Result {
  const { input, memories, edges } = buildE2Scenario();
  const fuseOutput = fuse(input);

  const questions = ALL_TAGS.map((tag) => ({ tag, question: `为什么推荐${TAG_LABELS[tag]}？` }));
  const explanations = questions.map((q) => explain(q.question, fuseOutput, memories, edges));

  const testablePairs = explanations
    .map((exp, i) => ({ exp, question: questions[i].question }))
    .filter((p) => p.exp.citedEdgeIds.length > 0);

  const batch = faithfulnessBatch(
    testablePairs.map((p) => p.exp),
    input,
  );

  const details: E2Detail[] = testablePairs.map((p, i) => ({
    question: p.question,
    tag: p.exp.tag,
    cited: p.exp.citedEdgeIds.length,
    before: batch.details[i].before,
    after: batch.details[i].after,
    flipped: batch.details[i].flipped,
  }));

  const total = explanations.length;
  const testable = details.length;
  const skipped = total - testable;
  const faithful = details.filter((d) => d.flipped).length;
  const rate = testable > 0 ? faithful / testable : 0;

  const lines: string[] = [];
  lines.push('| 问题 | 引用边数 | 移除前 top-3 | 移除后 top-3 | 翻转 |');
  lines.push('|---|---|---|---|---|');
  for (const d of details) {
    lines.push(
      `| ${d.question} | ${d.cited} | ${d.before.join(', ') || '—'} | ${d.after.join(', ') || '—'} | ${d.flipped ? '✓' : '✗'} |`,
    );
  }

  const summary = [
    `总解释数: ${total}`,
    `可检验解释数: ${testable}（无引用边、无从反事实检验的 ${skipped} 条已排除）`,
    `忠实解释数: ${faithful}`,
    `平均忠实度: ${rate.toFixed(3)}`,
  ].join('\n');

  return {
    total,
    testable,
    skipped,
    faithful,
    rate,
    details,
    table: lines.join('\n'),
    summary,
  };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('e2_faithfulness.ts');
if (isMain) {
  const r = runE2();
  console.log('E2 · 反事实忠实度\n');
  console.log(r.table);
  console.log('');
  console.log(r.summary);
  const unfaithful = r.details.filter((d) => !d.flipped);
  if (unfaithful.length > 0) {
    console.log('');
    console.log('判为不忠实的解释（多为"个人记忆已主导，社会边非决定性"）：');
    for (const d of unfaithful) console.log(`  - ${d.question}`);
  }
}
