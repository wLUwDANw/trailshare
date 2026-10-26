/**
 * 时间与衰减。纯函数，禁止读 Date.now()。
 * 所有函数都要求显式传入 now，保证实验可复现、测试可断言。
 */

export const MS_PER_DAY = 86_400_000;

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

export function daysSince(iso: string, now: Date): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now.getTime() - t) / MS_PER_DAY);
}

/**
 * 指数衰减：每过 halfLifeDays 天权重减半。
 * Ebbinghaus 遗忘曲线的标准形式，数学上简洁、实验上可调。
 */
export function decay(daysAgo: number, halfLifeDays: number): number {
  if (!Number.isFinite(daysAgo) || daysAgo <= 0) return 1;
  const half = halfLifeDays > 0 ? halfLifeDays : 90;
  return Math.pow(0.5, daysAgo / half);
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
