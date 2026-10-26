/** 极小的 DOM 工具。所有插入用户可控文本的地方都必须先 escape。 */

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function qs<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`找不到元素：${selector}`);
  return el as T;
}

export function toast(message: string): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 2400);
}

export function shortHex(value: string, head = 8, tail = 6): string {
  const v = value.includes(':') ? value.split(':')[1] : value;
  if (v.length <= head + tail + 1) return v;
  return `${v.slice(0, head)}…${v.slice(-tail)}`;
}
