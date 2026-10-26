/**
 * 入口。初始化身份、挂载三个 Tab。
 *
 * 没有路由、没有框架、没有后端：全部状态在 IndexedDB 里，全部算法在 src/agent。
 */
import './style.css';
import { ensureKeyPair } from './store/keys';
import { chainHealth } from './store/chainStore';
import { fingerprint } from './crypto/keys';
import { setupTabs } from './ui/tabs';
import { mountLibrary } from './ui/tabLibrary';
import { mountTrips } from './ui/tripList';
import { mountCreate } from './ui/tabCreate';
import { mountImport } from './ui/tabImport';
import { mountFriends } from './ui/tabFriends';
import { seedDemoFriends } from './store/friends';
import { isChainEnabled, setChainEnabled } from './config';
import { escapeHtml, toast } from './ui/dom';

const SHELL = `
  <div class="shell">
    <header class="top">
      <div class="brand">
        <h1>TrailShare</h1>
        <span class="sub">旅迹信物</span>
      </div>
      <nav class="tabs" role="tablist" aria-label="主导航">
        <button role="tab" data-tab="trips" aria-selected="true">旅程</button>
        <button role="tab" data-tab="library" aria-selected="false">记忆库</button>
        <button role="tab" data-tab="create" aria-selected="false">生成信物</button>
        <button role="tab" data-tab="import" aria-selected="false">导入信物</button>
        <button role="tab" data-tab="friends" aria-selected="false">好友</button>
      </nav>
      <div class="who">
        <label class="badge" title="关闭后信物照常生成/接受，只是 chainAnchor = null（旁路不阻塞主流程）">
          <input type="checkbox" id="chain-toggle" style="margin:0 4px 0 0" />
          链锚定
        </label>
        <span>公钥</span>
        <code id="pubkey">…</code>
      </div>
    </header>

    <section class="panel active" id="panel-trips"></section>
    <section class="panel" id="panel-library"></section>
    <section class="panel" id="panel-create"></section>
    <section class="panel" id="panel-import"></section>
    <section class="panel" id="panel-friends"></section>
  </div>`;

async function boot(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('缺少 #app 挂载点');
  app.innerHTML = SHELL;

  const keys = await ensureKeyPair(new Date());
  const pubEl = document.getElementById('pubkey');
  if (pubEl) {
    pubEl.textContent = fingerprint(`ed25519:${keys.pubHex}`);
    pubEl.title = `ed25519:${keys.pubHex}`;
  }

  const toggle = document.getElementById('chain-toggle') as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = isChainEnabled();
    toggle.addEventListener('change', () => {
      setChainEnabled(toggle.checked);
      toast(toggle.checked ? '链锚定已开启' : '链锚定已关闭：功能照常，chainAnchor = null');
    });
  }

  // 开发占位：首次启动预置 3 个测试好友（幂等，表里有人就跳过）。
  // 必须在 mountCreate 之前跑完，否则第一次打开时收件人列表是空的。
  // 失败不影响主流程——最多是收件人列表空着。
  try {
    await seedDemoFriends();
  } catch (err) {
    console.warn('预置测试好友失败（不影响使用）', err);
  }

  mountTrips(document.getElementById('panel-trips') as HTMLElement);
  mountLibrary(document.getElementById('panel-library') as HTMLElement);
  mountCreate(document.getElementById('panel-create') as HTMLElement, keys);
  mountImport(document.getElementById('panel-import') as HTMLElement);
  mountFriends(document.getElementById('panel-friends') as HTMLElement, keys);

  setupTabs('trips');

  if (isChainEnabled()) {
    const health = await chainHealth();
    if (!health.ok) {
      toast(`本地链在 seq=${health.brokenAt} 处断裂，可清空站点数据重新初始化`);
    }
  }
}

void boot().catch((err: unknown) => {
  const app = document.getElementById('app');
  if (!app) return;
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(err);
  app.innerHTML = `
    <div class="shell">
      <div class="card" style="padding:24px;margin-top:48px">
        <h2 style="margin:0 0 8px;font-size:16px">启动失败</h2>
        <p class="hint" style="margin:0 0 12px">
          应用没能初始化。常见原因：浏览器禁用了 IndexedDB（无痕/隐私模式），
          或者页面不是通过 http(s) 打开的（file:// 下 IndexedDB 与加密接口都不可用）。
        </p>
        <pre class="mono" style="white-space:pre-wrap;margin:0">${escapeHtml(msg)}</pre>
      </div>
    </div>`;
});
