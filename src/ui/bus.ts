/** 数据变更广播。Store 写完以后 emit，各个 Tab 各自刷新。 */

const listeners = new Set<() => void>();

export function onDataChanged(fn: () => void): void {
  listeners.add(fn);
}

export function emitDataChanged(): void {
  for (const fn of listeners) fn();
}
