/**
 * Tab1 · 旅程列表。
 *
 * 列表页只做三件事：列出来、建新的、点进去。
 * 编辑器在 tripEditor.ts，同样是"改一次就写一次 IndexedDB"，没有保存按钮。
 */
import { listTrips, deleteTrip, newTrip, putTrip, tripStats, coverPhotoOf, todayString } from '../store/trips';
import { bytesToDataUrl } from '../utils/image';
import { escapeHtml, qs, toast } from './dom';
import { closeModal, openModal } from './modal';
import { onTabShow } from './tabs';
import { renderTripEditor } from './tripEditor';
import type { Trip } from '../types';

export function mountTrips(root: HTMLElement): void {
  let openTripId: string | null = null;

  root.innerHTML = '<div id="trips-body"></div>';
  const body = qs<HTMLDivElement>(root, '#trips-body');

  function coverOf(trip: Trip): string {
    const photo = coverPhotoOf(trip);
    if (!photo) return '';
    try {
      return bytesToDataUrl(new Uint8Array(photo.image));
    } catch {
      return '';
    }
  }

  function cardHtml(trip: Trip): string {
    const stats = tripStats(trip);
    const cover = coverOf(trip);
    return `<article class="trip-card" data-trip="${escapeHtml(trip.id)}">
      ${cover ? `<img class="trip-cover" src="${cover}" alt="${escapeHtml(trip.title)}封面" loading="lazy" />` : '<div class="trip-cover empty-cover">还没有照片</div>'}
      <div class="trip-meta">
        <div class="spread">
          <strong class="trip-title">${escapeHtml(trip.title || '未命名旅程')}</strong>
          <button type="button" class="trip-del" data-del="${escapeHtml(trip.id)}" title="删除这次旅程" aria-label="删除旅程">×</button>
        </div>
        <span class="hint">${stats.days} 天 · ${stats.places} 个地点 · ${stats.photos} 张照片</span>
      </div>
    </article>`;
  }

  async function renderList(): Promise<void> {
    let trips: Trip[] = [];
    try {
      trips = await listTrips();
    } catch (err) {
      console.error(err);
      body.innerHTML = '<div class="empty">旅程读取失败（浏览器可能禁用了 IndexedDB）</div>';
      return;
    }

    body.innerHTML = `
      <div class="spread" style="margin-bottom:18px">
        <div>
          <h2 class="page-title">我的旅程</h2>
          <p class="hint" style="margin:4px 0 0">把多天、多地点、带配文的照片整理成一段旅程，再决定给谁看哪几天。</p>
        </div>
        <button type="button" class="btn seal" id="new-trip">＋ 新建旅程</button>
      </div>
      ${
        trips.length === 0
          ? `<div class="empty card" style="padding:48px 20px">
               <h3>还没有旅程</h3>
               新建一次旅程，先加一天，再往这一天里放地点和照片。
             </div>`
          : `<div class="trip-grid">${trips.map(cardHtml).join('')}</div>`
      }`;

    qs<HTMLButtonElement>(body, '#new-trip').addEventListener('click', async () => {
      const trip = newTrip(`旅程 ${new Date().toLocaleDateString('zh-CN')}`);
      trip.days.push({ id: `d_${Math.random().toString(36).slice(2, 8)}`, date: todayString(), places: [] });
      await putTrip(trip);
      openTripId = trip.id;
      await refresh();
    });

    body.querySelectorAll<HTMLElement>('[data-trip]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        if ((e.target as HTMLElement).closest('[data-del]')) return;
        openTripId = el.dataset.trip ?? null;
        await refresh();
      });
    });

    body.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.del ?? '';
        const trip = trips.find((t) => t.id === id);
        if (trip) confirmDelete(trip);
      });
    });
  }

  function confirmDelete(trip: Trip): void {
    const stats = tripStats(trip);
    openModal(
      '删除这次旅程？',
      `<p class="say" style="margin:0 0 12px">${escapeHtml(trip.title || '未命名旅程')}（${stats.days} 天 · ${stats.places} 个地点 · ${stats.photos} 张照片）</p>
       <ul style="margin:0 0 16px;padding-left:18px;font-size:13px;line-height:1.9;color:var(--ink-2)">
         <li>旅程和里面的照片会被删除</li>
         <li>已经生成并发送出去的信物不受影响</li>
         <li>已经收进记忆库的内容不受影响</li>
       </ul>
       <div class="row" style="justify-content:flex-end">
         <button type="button" class="btn ghost sm" id="cancel-trip-del">取消</button>
         <button type="button" class="btn seal sm" id="confirm-trip-del">确认删除</button>
       </div>`,
    );
    document.getElementById('cancel-trip-del')?.addEventListener('click', closeModal);
    document.getElementById('confirm-trip-del')?.addEventListener('click', async () => {
      try {
        await deleteTrip(trip.id);
        closeModal();
        toast('已删除这次旅程');
        await renderList();
      } catch (err) {
        console.error(err);
        toast('删除失败');
      }
    });
  }

  async function refresh(): Promise<void> {
    if (!openTripId) {
      await renderList();
      return;
    }
    const trip = await import('../store/trips').then((m) => m.getTrip(openTripId as string));
    if (!trip) {
      openTripId = null;
      await renderList();
      return;
    }
    renderTripEditor(body, trip, () => {
      openTripId = null;
      void renderList();
    });
  }

  onTabShow('trips', () => {
    if (!openTripId) void renderList();
  });

  void renderList();
}
