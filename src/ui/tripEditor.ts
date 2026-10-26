/**
 * Trip 编辑器（本地）。
 *
 * 自动保存：所有输入都直接改内存里的 trip，然后 debounce 250ms 写 IndexedDB。
 * 没有"保存"按钮——这是刻意的，评委不会因为忘了点保存而丢掉演示数据。
 *
 * 结构变化（加/删 Day、Place、Photo、换封面）会整块重渲染；
 * 文本输入不重渲染，否则每敲一个字焦点就飞了。
 */
import { ALL_TAGS, INTENSITY_MEANING, INTENSITY_STARS, TAG_LABELS } from '../types';
import type { Day, IntensityBucket, Place, Tag, Trip } from '../types';
import { MAX_PHOTOS } from '../share/schema';
import { newPlace, putTrip, todayString } from '../store/trips';
import { compressImageBatch, bytesToDataUrl } from '../utils/image';
import { toStorage } from '../utils/binary';
import { escapeHtml, qs, toast } from './dom';
import { closeModal, openModal } from './modal';
import { uuid } from '../utils/id';

const STAR_LEVELS: readonly IntensityBucket[] = ['low', 'mid', 'high'] as const;

export function renderTripEditor(container: HTMLElement, trip: Trip, onBack: () => void): void {
  let timer: number | null = null;
  let busy = false;

  function saveNow(): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    void putTrip(trip).catch((err) => {
      console.error(err);
      toast('自动保存失败');
    });
  }

  function scheduleSave(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      saveNow();
    }, 250);
  }

  function confirmThen(title: string, body: string, onYes: () => void): void {
    openModal(
      title,
      `<p class="say" style="margin:0 0 14px">${escapeHtml(body)}</p>
       <div class="row" style="justify-content:flex-end">
         <button type="button" class="btn ghost sm" id="cancel-op">取消</button>
         <button type="button" class="btn seal sm" id="confirm-op">确认</button>
       </div>`,
    );
    document.getElementById('cancel-op')?.addEventListener('click', closeModal);
    document.getElementById('confirm-op')?.addEventListener('click', () => {
      closeModal();
      onYes();
    });
  }

  function photoHtml(place: Place, index: number): string {
    const photo = place.photos[index];
    let src = '';
    try {
      src = bytesToDataUrl(new Uint8Array(photo.image));
    } catch {
      src = '';
    }
    const isCover = index === place.coverIndex;
    return `<figure class="trip-photo${isCover ? ' is-cover' : ''}">
      <button type="button" class="trip-photo-img" data-set-cover="${index}" title="设为这个地点的封面">
        ${src ? `<img src="${src}" alt="第 ${index + 1} 张" />` : '<span class="hint">无图</span>'}
      </button>
      ${isCover ? '<span class="photo-badge">封面</span>' : ''}
      <button type="button" class="photo-remove" data-del-photo="${index}" aria-label="删除第 ${index + 1} 张">×</button>
      <textarea class="caption-input" data-caption="${index}" rows="2" maxlength="120"
        placeholder="配文（可留空）">${escapeHtml(photo.caption ?? '')}</textarea>
    </figure>`;
  }

  function placeHtml(place: Place): string {
    const full = place.photos.length >= MAX_PHOTOS;
    return `<div class="place-card" data-place="${escapeHtml(place.id)}">
      <div class="place-head">
        <input type="text" data-place-name value="${escapeHtml(place.name)}" maxlength="40" placeholder="地点名（必填）" />
        <input type="text" data-place-label value="${escapeHtml(place.label ?? '')}" maxlength="12" placeholder="上午/下午（可选）" />
        <button type="button" class="btn ghost sm" data-del-place>删除地点</button>
      </div>

      <div class="place-controls">
        <label class="inline-field">标签
          <select data-place-tag>
            ${ALL_TAGS.map((t) => `<option value="${t}"${t === place.tag ? ' selected' : ''}>${TAG_LABELS[t]}</option>`).join('')}
          </select>
        </label>
        <div class="stars" role="radiogroup" aria-label="强度">
          ${STAR_LEVELS.map((value) => {
            const on = value === place.intensity;
            return `<button type="button" role="radio" aria-checked="${on}" data-place-intensity="${value}"
              class="star-btn${on ? ' on' : ''}">
              <span class="star-line">${INTENSITY_STARS[value]}</span>
              <span class="star-label">${INTENSITY_MEANING[value]}</span>
            </button>`;
          }).join('')}
        </div>
      </div>

      <div class="photo-strip">
        ${place.photos.map((_, i) => photoHtml(place, i)).join('')}
        ${
          full
            ? '<div class="add-photo-tile disabled">已满 5 张</div>'
            : `<button type="button" class="add-photo-tile" data-add-photos>＋ 照片</button>`
        }
      </div>
      <input type="file" accept="image/*" multiple hidden data-file />
    </div>`;
  }

  function dayHtml(day: Day): string {
    return `<section class="day-card" data-day="${escapeHtml(day.id)}">
      <header class="day-head">
        <input type="date" data-day-date value="${escapeHtml(day.date)}" />
        <span class="hint">${day.places.length} 个地点 · ${day.places.reduce((n, p) => n + p.photos.length, 0)} 张照片</span>
        <button type="button" class="btn ghost sm" data-del-day>删除这天</button>
      </header>
      <div class="places">
        ${day.places.length === 0 ? '<div class="hint" style="padding:10px 2px">这一天还没有地点。</div>' : day.places.map((p) => placeHtml(p)).join('')}
      </div>
      <button type="button" class="btn ghost sm" data-add-place>＋ 在这一天添加地点</button>
    </section>`;
  }

  function render(): void {
    container.innerHTML = `
      <div class="trip-editor">
        <div class="spread" style="margin-bottom:14px">
          <button type="button" class="btn ghost sm" id="trip-back">← 返回旅程列表</button>
          <span class="hint">改动自动保存</span>
        </div>
        <input type="text" id="trip-title" class="trip-title-input" maxlength="40"
          value="${escapeHtml(trip.title)}" placeholder="这次旅程叫什么" />
        <div id="days">${trip.days.map(dayHtml).join('')}</div>
        <button type="button" class="btn ghost" id="add-day" style="margin-top:6px">＋ 添加一天</button>
      </div>`;
    bind();
  }

  function bind(): void {
    qs<HTMLButtonElement>(container, '#trip-back').addEventListener('click', () => {
      saveNow();
      onBack();
    });

    qs<HTMLInputElement>(container, '#trip-title').addEventListener('input', (e) => {
      trip.title = (e.target as HTMLInputElement).value;
      scheduleSave();
    });

    qs<HTMLButtonElement>(container, '#add-day').addEventListener('click', () => {
      trip.days.push({ id: `d_${uuid().slice(0, 8)}`, date: todayString(), places: [] });
      saveNow();
      render();
    });

    container.querySelectorAll<HTMLElement>('[data-day]').forEach((dayEl) => {
      const day = trip.days.find((d) => d.id === dayEl.dataset.day);
      if (!day) return;

      dayEl.querySelector<HTMLInputElement>('[data-day-date]')?.addEventListener('change', (e) => {
        day.date = (e.target as HTMLInputElement).value || todayString();
        scheduleSave();
      });

      dayEl.querySelector<HTMLButtonElement>('[data-del-day]')?.addEventListener('click', () => {
        const photos = day.places.reduce((n, p) => n + p.photos.length, 0);
        confirmThen(
          '删除这一天？',
          `这一天的 ${day.places.length} 个地点、${photos} 张照片都会从旅程里删掉。`,
          () => {
            trip.days = trip.days.filter((d) => d.id !== day.id);
            saveNow();
            render();
          },
        );
      });

      dayEl.querySelector<HTMLButtonElement>('[data-add-place]')?.addEventListener('click', () => {
        day.places.push(newPlace());
        saveNow();
        render();
      });

      dayEl.querySelectorAll<HTMLElement>('[data-place]').forEach((placeEl) => {
        const place = day.places.find((p) => p.id === placeEl.dataset.place);
        if (!place) return;

        placeEl.querySelector<HTMLInputElement>('[data-place-name]')?.addEventListener('input', (e) => {
          place.name = (e.target as HTMLInputElement).value;
          scheduleSave();
        });
        placeEl.querySelector<HTMLInputElement>('[data-place-label]')?.addEventListener('input', (e) => {
          const value = (e.target as HTMLInputElement).value.trim();
          if (value) place.label = value;
          else delete place.label;
          scheduleSave();
        });
        placeEl.querySelector<HTMLSelectElement>('[data-place-tag]')?.addEventListener('change', (e) => {
          place.tag = (e.target as HTMLSelectElement).value as Tag;
          scheduleSave();
        });

        placeEl.querySelectorAll<HTMLButtonElement>('[data-place-intensity]').forEach((btn) => {
          btn.addEventListener('click', () => {
            place.intensity = btn.dataset.placeIntensity as IntensityBucket;
            saveNow();
            render();
          });
        });

        placeEl.querySelector<HTMLButtonElement>('[data-del-place]')?.addEventListener('click', () => {
          confirmThen('删除这个地点？', `「${place.name || '未命名地点'}」和它的 ${place.photos.length} 张照片会被删除。`, () => {
            day.places = day.places.filter((p) => p.id !== place.id);
            saveNow();
            render();
          });
        });

        const fileInput = placeEl.querySelector<HTMLInputElement>('[data-file]');
        placeEl.querySelector<HTMLButtonElement>('[data-add-photos]')?.addEventListener('click', () => {
          fileInput?.click();
        });
        fileInput?.addEventListener('change', async () => {
          const files = Array.from(fileInput.files ?? []);
          fileInput.value = '';
          if (files.length === 0 || busy) return;
          busy = true;
          try {
            const room = MAX_PHOTOS - place.photos.length;
            if (room <= 0) {
              toast(`一个地点最多 ${MAX_PHOTOS} 张`);
              return;
            }
            const picked = files.slice(0, room);
            if (files.length > room) toast(`最多 ${MAX_PHOTOS} 张，已保留前 ${room} 张`);
            const compressed = await compressImageBatch(picked);
            let added = 0;
            compressed.forEach((bytes, i) => {
              if (!bytes) {
                toast(`「${picked[i].name}」压缩失败，已跳过`);
                return;
              }
              place.photos.push({
                id: `ph_${uuid().slice(0, 8)}`,
                image: toStorage(bytes),
                caption: '',
              });
              added += 1;
            });
            if (added > 0) {
              saveNow();
              render();
            }
          } finally {
            busy = false;
          }
        });

        placeEl.querySelectorAll<HTMLElement>('[data-set-cover]').forEach((el) => {
          el.addEventListener('click', () => {
            place.coverIndex = Number(el.dataset.setCover);
            trip.coverPlaceId = place.id;
            saveNow();
            render();
          });
        });

        placeEl.querySelectorAll<HTMLButtonElement>('[data-del-photo]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const index = Number(btn.dataset.delPhoto);
            place.photos.splice(index, 1);
            if (place.photos.length === 0) place.coverIndex = 0;
            else if (place.coverIndex >= place.photos.length) place.coverIndex = place.photos.length - 1;
            else if (index < place.coverIndex) place.coverIndex -= 1;
            saveNow();
            render();
          });
        });

        placeEl.querySelectorAll<HTMLTextAreaElement>('[data-caption]').forEach((input) => {
          input.addEventListener('input', () => {
            const index = Number(input.dataset.caption);
            const photo = place.photos[index];
            if (!photo) return;
            const value = input.value;
            if (value.trim()) photo.caption = value;
            else delete photo.caption;
            scheduleSave();
          });
        });
      });
    });
  }

  render();
}
