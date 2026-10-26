/**
 * 一次跑完四个实验，输出可直接粘进报告的 Markdown。
 *   npx tsx src/experiments/run_all.ts
 */
import { runE1 } from './e1_privacy';
import { runE2 } from './e2_faithfulness';
import { runE3 } from './e3_ablation';
import { runE4 } from './e4_multihop';

export function runAll(): string {
  const e1 = runE1();
  const e2 = runE2();
  const e3 = runE3();
  const e4 = runE4();

  const blocks: string[] = [];

  blocks.push('## E1 · 隐私–可验证–效用矩阵\n');
  blocks.push(e1.table);
  blocks.push('');
  blocks.push('## E2 · 反事实忠实度\n');
  blocks.push(e2.table);
  blocks.push('');
  blocks.push('```');
  blocks.push(e2.summary);
  blocks.push('```');
  blocks.push('');
  blocks.push('## E3 · 三策略消融\n');
  blocks.push(e3.table);
  blocks.push('');
  blocks.push(e3.summary);
  blocks.push('');
  blocks.push('## E4 · 多跳传播衰减\n');
  blocks.push(e4.table);
  blocks.push('');

  return blocks.join('\n');
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('run_all.ts');
if (isMain) {
  console.log('# TrailShare 实验输出\n');
  console.log(runAll());
}
