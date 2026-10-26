/**
 * 全局开关。链锚定默认开启，可通过 localStorage 关掉：
 *   localStorage.setItem('trailshare:chain_enabled', 'false')
 * 关掉后应用功能完整（只是 chainAnchor = null），用于验证"旁路永不阻塞主流程"。
 */
const CHAIN_KEY = 'trailshare:chain_enabled';
const NAME_KEY = 'trailshare:display_name';

export function isChainEnabled(): boolean {
  try {
    const v = localStorage.getItem(CHAIN_KEY);
    return v === null ? true : v !== 'false';
  } catch {
    return true;
  }
}

export function setChainEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(CHAIN_KEY, String(enabled));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略 */
  }
}

/**
 * 显示名。只是人可读的标签，不参与任何验证——
 * 真正的身份是公钥，显示名可以被任意伪造（信物里同时存着公钥）。
 */
export function getDisplayName(): string {
  try {
    const v = localStorage.getItem(NAME_KEY);
    return v && v.trim() ? v.trim().slice(0, 16) : '我';
  } catch {
    return '我';
  }
}

export function setDisplayName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.trim().slice(0, 16));
  } catch {
    /* 忽略 */
  }
}
