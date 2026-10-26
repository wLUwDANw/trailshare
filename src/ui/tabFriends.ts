/**
 * Tab4 · 好友（收件人）。
 *
 * 定向加密需要对方的 Ed25519 公钥。公钥靠线下/其它渠道交换，这里只负责：
 * 展示我的公钥、手工添加对方公钥、删除。
 *
 * X25519 公钥不用对方提供——从 Ed25519 公钥用 RFC 7748 的标准转换派生即可，
 * 两边算出来一定一样（见 src/crypto/keys.ts 的 ed25519ToX25519Pub）。
 */
import { addFriend, listFriends, removeFriend, type Friend } from '../store/friends';
import { ed25519ToX25519Pub } from '../crypto/keys';
import type { KeyPairRecord } from '../types';
import { escapeHtml, qs, shortHex, toast } from './dom';
import { closeModal, openModal } from './modal';

export function mountFriends(root: HTMLElement, keys: KeyPairRecord): void {
  const myPubkey = `ed25519:${keys.pubHex}`;

  root.innerHTML = `
    <div class="friends-grid">
      <div class="card" style="padding:18px">
        <h2 class="sec-title">我的公钥</h2>
        <p class="hint" style="margin:0 0 10px">
          把这一串发给朋友，他填进「添加好友」，你才会出现在他的收件人列表里。
        </p>
        <div class="pub-box mono" id="my-pub">${escapeHtml(myPubkey)}</div>
        <div class="row" style="margin-top:10px">
          <button type="button" class="btn ghost sm" id="copy-pub">复制公钥</button>
          <span class="hint">身份以公钥为准，昵称可以随便改</span>
        </div>

        <h2 class="sec-title" style="margin-top:22px">添加好友</h2>
        <form id="add-form">
          <div class="field">
            <label for="fpub">对方的公钥</label>
            <input type="text" id="fpub" placeholder="ed25519:… 或 64 位十六进制" autocomplete="off" spellcheck="false" />
          </div>
          <div class="field">
            <label for="fname">备注名</label>
            <input type="text" id="fname" maxlength="16" placeholder="例如：老王" autocomplete="off" />
          </div>
          <div class="row">
            <button type="submit" class="btn seal sm">添加</button>
          </div>
        </form>
        <p class="hint" style="margin:10px 0 0">
          公钥没有在线验证机制——你复制到的公钥如果被人替换，内容就会加密给错误的人。
          生产环境需要带外核验（二维码 / 短指纹），见 README。
        </p>
      </div>

      <div class="card" style="padding:18px">
        <div class="spread" style="margin-bottom:12px">
          <h2 class="sec-title" style="margin:0">好友列表</h2>
          <span class="badge" id="fcount">0 人</span>
        </div>
        <div id="flist"></div>
      </div>
    </div>`;

  const listBox = qs<HTMLDivElement>(root, '#flist');
  const countEl = qs<HTMLSpanElement>(root, '#fcount');

  function friendHtml(f: Friend): string {
    return `<div class="friend-row" data-pub="${escapeHtml(f.pubkey)}">
      <div class="friend-main">
        <strong>${escapeHtml(f.name)}</strong>
        <span class="mono hint">${escapeHtml(shortHex(f.pubkey, 8, 6))}</span>
      </div>
      <button type="button" class="btn ghost sm" data-del="${escapeHtml(f.pubkey)}">删除</button>
    </div>`;
  }

  async function refresh(): Promise<void> {
    let friends: Friend[] = [];
    try {
      friends = await listFriends();
    } catch (err) {
      console.error(err);
      listBox.innerHTML = '<div class="empty">好友表读取失败（浏览器可能禁用了 IndexedDB）</div>';
      return;
    }

    countEl.textContent = `${friends.length} 人`;
    if (friends.length === 0) {
      listBox.innerHTML = `<div class="empty" style="padding:28px 8px">
        还没有好友。把对方的公钥填到左边，或者让对方把公钥发给你。</div>`;
      return;
    }

    listBox.innerHTML = friends.map((f) => friendHtml(f)).join('');
    listBox.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pubkey = btn.dataset.del ?? '';
        const friend = friends.find((f) => f.pubkey === pubkey);
        if (friend) confirmRemove(friend);
      });
    });
  }

  function confirmRemove(f: Friend): void {
    openModal(
      '删除好友？',
      `<p class="say" style="margin:0 0 12px">${escapeHtml(f.name)} 会从收件人列表里消失。</p>
       <p class="hint" style="margin:0 0 14px">
         已经收到的信物不受影响；你之后也不能再给他寄定向信物，除非重新添加公钥。
       </p>
       <div class="row" style="justify-content:flex-end">
         <button type="button" class="btn ghost sm" id="cancel-del-friend">取消</button>
         <button type="button" class="btn seal sm" id="confirm-del-friend">确认删除</button>
       </div>`,
    );
    document.getElementById('cancel-del-friend')?.addEventListener('click', closeModal);
    document.getElementById('confirm-del-friend')?.addEventListener('click', async () => {
      try {
        await removeFriend(f.pubkey);
        closeModal();
        toast(`已删除好友「${f.name}」`);
        await refresh();
      } catch (err) {
        console.error(err);
        toast('删除失败');
      }
    });
  }

  qs<HTMLButtonElement>(root, '#copy-pub').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(myPubkey);
      toast('公钥已复制');
    } catch {
      toast('复制失败，请手动选择');
    }
  });

  qs<HTMLFormElement>(root, '#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pubInput = qs<HTMLInputElement>(root, '#fpub');
    const nameInput = qs<HTMLInputElement>(root, '#fname');
    const raw = pubInput.value.replace(/\s+/g, '');
    const name = nameInput.value.trim();

    try {
      // 先派生一次，公钥非法时在这里就报错，不会写进库里
      const bare = raw.replace(/^ed25519:/i, '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(bare)) throw new Error('公钥必须是 64 位十六进制（可带 ed25519: 前缀）');
      const x25519Pub = ed25519ToX25519Pub(`ed25519:${bare}`);

      await addFriend({
        pubkey: `ed25519:${bare}`,
        name: name || '朋友',
        addedAt: new Date().toISOString(),
        x25519Pub,
      });
      pubInput.value = '';
      nameInput.value = '';
      toast(`已添加「${name || '朋友'}」`);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : '添加失败');
    }
  });

  void refresh();
}
