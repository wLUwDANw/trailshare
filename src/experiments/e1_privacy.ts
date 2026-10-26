/**
 * E1 · 隐私–可验证–效用矩阵。
 *
 * 简化威胁模型（必须在报告里明写）：
 * - 攻击者拿到 .trailshare 文件，但没有口令；
 * - 对 plain 档：内容明文，猜对率 100%；
 * - 对 encrypted / commitment_only：只能均匀猜六类标签 × 三档强度，猜对率 ≈ 1/18；
 * - 额外考虑侧信道泄露（文件大小、创建时间、链序号）。
 *
 * 隐私分 = 0.4 × 内容隐藏 + 0.3 × (1 − 猜对率) + 0.3 × (1 − 侧信道泄露)
 * 这是一个**明确定义在代码里的模型**，不是领域公认指标；改动权重会改变数值。
 */
import type { Granularity } from '../types';
import { GRANULARITY_LABELS } from '../types';

export interface E1Row {
  granularity: Granularity;
  privacyScore: number;
  verifiabilityScore: number;
  utilityScore: number;
  note: string;
}

export interface E1Result {
  rows: E1Row[];
  trials: number;
  simulatedAccuracy: number;
  table: string;
}

export const W_CONTENT = 0.4;
export const W_GUESS = 0.3;
export const W_LEAK = 0.3;

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 模拟一个"只能均匀猜"的攻击者：对 18 种真实组合逐一尝试，统计猜中比例。 */
export function simulateUniformGuess(trials: number, seed = 20261018): number {
  const rng = mulberry32(seed);
  let hits = 0;
  let total = 0;
  for (let truthTag = 0; truthTag < 6; truthTag += 1) {
    for (let truthIntensity = 0; truthIntensity < 3; truthIntensity += 1) {
      for (let i = 0; i < trials; i += 1) {
        const guessTag = Math.floor(rng() * 6);
        const guessIntensity = Math.floor(rng() * 3);
        if (guessTag === truthTag && guessIntensity === truthIntensity) hits += 1;
        total += 1;
      }
    }
  }
  return hits / total;
}

export function privacyScore(contentHidden: number, accuracy: number, leakage: number): number {
  return W_CONTENT * contentHidden + W_GUESS * (1 - accuracy) + W_LEAK * (1 - leakage);
}

export function runE1(trials = 20000): E1Result {
  const accuracy = simulateUniformGuess(trials);

  const rows: E1Row[] = [
    {
      granularity: 'plain',
      privacyScore: privacyScore(0, 1, 1),
      verifiabilityScore: 1,
      utilityScore: 1,
      note: '照片与语义明文可读；签名/承诺均可验',
    },
    {
      granularity: 'encrypted',
      privacyScore: privacyScore(1, accuracy, 0.5),
      verifiabilityScore: 1,
      utilityScore: 1,
      note: '无口令只看到密文；侧信道（文件大小、创建时间）仍泄露少量信息',
    },
    {
      granularity: 'commitment_only',
      privacyScore: privacyScore(1, accuracy, 0),
      verifiabilityScore: 0.6,
      utilityScore: 0.2,
      note: '连密文都不发；只能验签，承诺无法与内容比对，故可验证分下调',
    },
  ];

  return { rows, trials, simulatedAccuracy: accuracy, table: renderE1Table(rows, trials, accuracy) };
}

export function renderE1Table(rows: E1Row[], trials: number, accuracy: number): string {
  const lines: string[] = [];
  lines.push('| 粒度 | 隐私分 | 可验证分 | 效用分 | 说明 |');
  lines.push('|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(
      `| ${GRANULARITY_LABELS[r.granularity]} (\`${r.granularity}\`) | ${r.privacyScore.toFixed(3)} | ${r.verifiabilityScore.toFixed(2)} | ${r.utilityScore.toFixed(2)} | ${r.note} |`,
    );
  }
  lines.push('');
  lines.push(
    `> 简化威胁模型：频率统计攻击者，18 种 (tag, intensity) 组合均匀猜测，模拟 ${trials} 次/组合，实测猜对率 ${(accuracy * 100).toFixed(2)}%（理论值 ${((1 / 18) * 100).toFixed(2)}%）。`,
  );
  return lines.join('\n');
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('e1_privacy.ts');
if (isMain) {
  const result = runE1();
  console.log('E1 · 隐私–可验证–效用矩阵\n');
  console.log(result.table);
}
