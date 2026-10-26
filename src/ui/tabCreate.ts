/**
 * Tab3 · 生成信物（v2026.4）。
 *
 * 流程：选一趟旅程 → 每一组勾选"哪些天/地点/照片/配文可见" → 选收件人 → 生成。
 *
 * 重要：勾掉的内容**不会被打包**（不是打包后隐藏）。applyVisibility 在 pack 之前过滤，
 * 所以接收方拿到的是一段连续时间线，看不到任何占位或总数。
 *
 * 多组：默认 1 组，最多 3 组。新组复制组 1 的旅程、屏蔽状态和收件人，之后可各自修改。
 */
import { INTENSITY_STARS, TAG_LABELS } from '../types';
import type { KeyPairRecord, SharePackage, Trip } from '../types';
import { bytesToDataUrl } from '../utils/image';
import { toStorage } from '../utils/binary';
import { applyVisibility, visibleStats, type FilterResult } from '../utils/filter';
import { pack, packageFileName, serializePackage } from '../share/pack';
import { MAX_GROUPS } from '../share/schema';
import { putChainRecord, lastChain } from '../store/chainStore';
import { putMemory } from '../store/memories';
import { listTrips, getTrip } from '../store/trips';
import { emptyVisibility, getVisibility, putVisibility, withHidden, type HiddenKind } from '../store/visibility';
import { listFriends, type Friend } from '../store/friends';
import { generateIdentityFromSeed, fingerprint } from '../crypto/keys';
import { isChainEnabled, setDisplayName, getDisplayName } from '../config';
import { emitDataChanged } from './bus';
import { escapeHtml, qs, toast, shortHex } from './dom';
import { onTabShow } from './tabs';
import { uuid } from '../utils/id';

interface GroupDraft {
  key: string;
  visibility: ReturnType<typeof emptyVisibility>;
  recipients: Set<string>;
}

function dateNoonIso(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function mountCreate(root: HTMLElement, keys: KeyPairRecord): void {
  const selfPubkey = `ed25519:${keys.pubHex}`;

  root.innerHTML = `
    <div class="create-stack">
      <div class="field" style="max-width:420px">
        <label for="nick">我的昵称（对方会看到，但身份以公钥为准）</label>
        <input type="text" id="nick" maxlength="16" autocomplete="off" value="${escapeHtml(getDisplayName())}" />
      </div>

      <div class="field" style="max-width:520px">
        <label for="trip-select">选择旅程</label>
        <select id="trip-select"></select>
      </div>

      <div id="groups"></div>

      <div class="row" style="margin-top:6px">
        <button type="button" class="btn ghost sm" id="add-group">＋ 添加一组</button>
        <span class="hint" id="group-count"></span>
      </div>

      <div class="row" style="margin-top:14px">
        <button type="button" class="btn seal" id="gen">生成信物</button>
        <button type="button" class="btn ghost sm" id="copy-pub">复制我的公钥</button>
      </div>

      <div class="result card" id="result"></div>
    </div>`;

  const tripSelect = qs<HTMLSelectElement>(root, '#trip-select');
  const groupsBox = qs<HTMLDivElement>(root, '#groups');
  const addBtn = qs<HTMLButtonElement>(root, '#add-group');
  const groupCount = qs<HTMLSpanElement>(root, '#group-count');
  const result = qs<HTMLDivElement>(root, '#result');
  const genBtn = qs<HTMLButtonElement>(root, '#gen');

  let trips: Trip[] = [];
  let trip: Trip | null = null;
  let groups: GroupDraft[] = [];
  let friends: Friend[] = [];
  let lastPackage: SharePackage | null = null;

  function resetGroups(nextTrip: Trip | null): void {
    groups = [
      {
        key: 'g1',
        visibility: emptyVisibility(nextTrip?.id ?? '', 'g1'),
        recipients: new Set([selfPubkey]),
      },
    ];
  }

  function invalidateResult(): void {
    if (lastPackage) {
      lastPackage = null;
      result.classList.remove('show');
    }
  }

  /* ---------------- 渲染 ---------------- */

  function visibilityTree(group: GroupDraft): string {
    if (!trip) return '<div class="hint">先在「旅程」页建一次旅程。</div>';
    if (trip.days.length === 0) return '<div class="hint">这趟旅程还没有添加任何一天。</div>';

    return trip.days
      .map((day) => {
        const dayHidden = group.visibility.hiddenDayIds.includes(day.id);
        const places = day.places
          .map((place) => {
            const placeHidden = dayHidden || group.visibility.hiddenPlaceIds.includes(place.id);
            const photos = place.photos
              .map((photo) => {
                const photoHidden = placeHidden || group.visibility.hiddenPhotoIds.includes(photo.id);
                let src = '';
                try {
                  src = bytesToDataUrl(new Uint8Array(photo.image));
                } catch {
                  src = '';
                }
                const captionHidden =
                  photoHidden || group.visibility.hiddenCaptionPhotoIds.includes(photo.id);
                return `<div class="vis-photo">
                  <label class="vis-check">
                    <input type="checkbox" data-vis="photo" data-id="${escapeHtml(photo.id)}"
                      ${photoHidden ? '' : 'checked'} ${placeHidden ? 'disabled' : ''} />
                    ${src ? `<img src="${src}" alt="照片" />` : '<span class="vis-noimg">无图</span>'}
                  </label>
                  ${
                    photo.caption?.trim()
                      ? `<label class="vis-caption-check">
                           <input type="checkbox" data-vis="caption" data-id="${escapeHtml(photo.id)}"
                             ${!captionHidden ? 'checked' : ''} ${photoHidden ? 'disabled' : ''} />
                           配文
                         </label>`
                      : ''
                  }
                </div>`;
              })
              .join('');

            return `<div class="vis-place${placeHidden ? ' is-hidden' : ''}">
              <label class="vis-check vis-place-check">
                <input type="checkbox" data-vis="place" data-id="${escapeHtml(place.id)}"
                  ${group.visibility.hiddenPlaceIds.includes(place.id) ? '' : 'checked'}
                  ${dayHidden ? 'disabled' : ''} />
                <span class="vis-place-name">${escapeHtml([place.label, place.name || '未命名地点'].filter(Boolean).join(' · '))}</span>
                <span class="hint">${TAG_LABELS[place.tag]} · ${INTENSITY_STARS[place.intensity]}</span>
              </label>
              <div class="vis-photos">${photos || '<span class="hint">这个地点还没有照片</span>'}</div>
            </div>`;
          })
          .join('');

        return `<div class="vis-day${dayHidden ? ' is-hidden' : ''}">
          <label class="vis-check vis-day-check">
            <input type="checkbox" data-vis="day" data-id="${escapeHtml(day.id)}" ${dayHidden ? '' : 'checked'} />
            <span class="vis-day-date">${escapeHtml(day.date)}</span>
            <span class="hint">${day.places.length} 个地点</span>
          </label>
          ${places || '<div class="hint" style="padding-left:22px">这一天还没有地点</div>'}
        </div>`;
      })
      .join('');
  }

  function recipientsHtml(group: GroupDraft, gi: number): string {
    const rows = [recipientRow(group, gi, selfPubkey, '我自己（本机回看）')];
    for (const f of friends) rows.push(recipientRow(group, gi, f.pubkey, f.name));
    if (friends.length === 0) {
      rows.push('<div class="hint">好友表是空的，去「好友」页添加公钥；否则只能发给自己。</div>');
    }
    return rows.join('');
  }

  function recipientRow(group: GroupDraft, gi: number, pubkey: string, name: string): string {
    const checked = group.recipients.has(pubkey) ? 'checked' : '';
    return `<label class="recipient">
      <input type="checkbox" data-rcpt="${gi}" value="${escapeHtml(pubkey)}" ${checked} />
      <span class="recipient-name">${escapeHtml(name)}</span>
      <span class="mono hint">${escapeHtml(fingerprint(pubkey))}</span>
    </label>`;
  }

  function groupHtml(group: GroupDraft, gi: number): string {
    const stats = trip ? visibleStats(applyVisibility(trip, group.visibility)) : { places: 0, photos: 0 };

    return `<section class="group-card" data-g="${gi}">
      <header class="group-head">
        <span class="group-no">组 ${gi + 1}</span>
        <span class="hint">给 ${group.recipients.size} 人 · 可见 ${stats.places} 个地点 / ${stats.photos} 张照片</span>
        <span class="grow"></span>
        ${groups.length > 1 ? `<button type="button" class="btn ghost sm" data-del-group="${gi}">删除本组</button>` : ''}
      </header>
      <div class="group-body">
        <div>
          <div class="field" style="margin-bottom:8px">
            <label>时间线（勾选 = 会打包）</label>
            <div class="vis-tree">${visibilityTree(group)}</div>
          </div>
        </div>
        <div>
          <div class="field">
            <label>接收方（谁可以解开这一组）</label>
            <div class="recipient-list">${recipientsHtml(group, gi)}</div>
          </div>
        </div>
      </div>
    </section>`;
  }

  function renderGroups(): void {
    groupsBox.innerHTML = groups.map((g, i) => groupHtml(g, i)).join('');
    addBtn.disabled = groups.length >= MAX_GROUPS;
    groupCount.textContent = `${groups.length} / ${MAX_GROUPS} 组 · 勾掉的条目不会被打包`;
    bindGroupEvents();
  }

  function bindGroupEvents(): void {
    groupsBox.querySelectorAll<HTMLInputElement>('[data-vis]').forEach((box) => {
      box.addEventListener('change', () => {
        const card = box.closest<HTMLElement>('[data-g]');
        if (!card) return;
        const group = groups[Number(card.dataset.g)];
        if (!group) return;
        const kind = box.dataset.vis as HiddenKind;
        group.visibility = withHidden(group.visibility, kind, box.dataset.id ?? '', !box.checked);
        void putVisibility(group.visibility);
        invalidateResult();
        renderGroups();
      });
    });

    groupsBox.querySelectorAll<HTMLInputElement>('[data-rcpt]').forEach((box) => {
      box.addEventListener('change', () => {
        const group = groups[Number(box.dataset.rcpt)];
        if (!group) return;
        if (box.checked) group.recipients.add(box.value);
        else group.recipients.delete(box.value);
        invalidateResult();
        const card = box.closest<HTMLElement>('[data-g]');
        const gi = card ? Number(card.dataset.g) : -1;
        if (!card || gi < 0 || !trip) return;
        const stats = visibleStats(applyVisibility(trip, group.visibility));
        const head = card.querySelector('.group-head .hint');
        if (head) head.textContent = `给 ${group.recipients.size} 人 · 可见 ${stats.places} 个地点 / ${stats.photos} 张照片`;
      });
    });

    groupsBox.querySelectorAll<HTMLButtonElement>('[data-del-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const gi = Number(btn.dataset.delGroup);
        if (groups.length <= 1) return;
        groups.splice(gi, 1);
        groups = groups.map((g, i) => ({
          ...g,
          key: `g${i + 1}`,
          visibility: {
            ...g.visibility,
            id: `${g.visibility.tripId}::g${i + 1}`,
            groupId: `g${i + 1}`,
          },
        }));
        invalidateResult();
        renderGroups();
      });
    });
  }

  /* ---------------- 旅程与好友 ---------------- */

  async function loadTrips(): Promise<void> {
    try {
      trips = await listTrips();
    } catch (err) {
      console.error(err);
      trips = [];
    }

    tripSelect.innerHTML = trips.length
      ? trips.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.title || '未命名旅程')}</option>`).join('')
      : '<option value="">（还没有旅程）</option>';

    const first = trips[0] ?? null;
    trip = first;
    if (first) {
      tripSelect.value = first.id;
      resetGroups(first);
      for (const g of groups) g.visibility = await getVisibility(first.id, g.key);
    } else {
      resetGroups(null);
    }
    renderGroups();
  }

  tripSelect.addEventListener('change', async () => {
    const id = tripSelect.value;
    trip = id ? await getTrip(id) : null;
    resetGroups(trip);
    if (trip) {
      for (const g of groups) g.visibility = await getVisibility(trip.id, g.key);
    }
    invalidateResult();
    renderGroups();
  });

  addBtn.addEventListener('click', () => {
    if (groups.length >= MAX_GROUPS) {
      toast(`最多 ${MAX_GROUPS} 组`);
      return;
    }
    // 复制组 1：旅程、屏蔽状态、收件人
    const source = groups[0];
    const key = `g${groups.length + 1}`;
    const copy: GroupDraft = {
      key,
      visibility: trip
        ? {
            ...source.visibility,
            id: `${trip.id}::${key}`,
            groupId: key,
            hiddenDayIds: [...source.visibility.hiddenDayIds],
            hiddenPlaceIds: [...source.visibility.hiddenPlaceIds],
            hiddenPhotoIds: [...source.visibility.hiddenPhotoIds],
            hiddenCaptionPhotoIds: [...source.visibility.hiddenCaptionPhotoIds],
          }
        : emptyVisibility('', key),
      recipients: new Set(source.recipients),
    };
    groups.push(copy);
    if (trip) void putVisibility(copy.visibility);
    renderGroups();
    toast('已复制组 1 的旅程、可见性与收件人');
  });

  qs<HTMLButtonElement>(root, '#copy-pub').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(selfPubkey);
      toast('公钥已复制');
    } catch {
      toast('复制失败，请手动选择公钥');
    }
  });

  onTabShow('create', () => {
    void refreshFriends();
    void loadTrips();
  });

  async function refreshFriends(): Promise<void> {
    try {
      friends = await listFriends();
    } catch (err) {
      console.error(err);
      friends = [];
    }
    renderGroups();
  }

  /* ---------------- 生成 ---------------- */

  genBtn.addEventListener('click', async () => {
    const currentTrip = trip;
    if (!currentTrip) {
      toast('先去「旅程」页建一次旅程');
      return;
    }
    if (currentTrip.days.length === 0) {
      toast('这趟旅程还没有内容');
      return;
    }

    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i];
      if (g.recipients.size === 0) {
        toast(`第 ${i + 1} 组还没选接收方`);
        return;
      }
      if (applyVisibility(currentTrip, g.visibility).visiblePlaces.length === 0) {
        toast(`第 ${i + 1} 组没有可见内容`);
        return;
      }
    }

    genBtn.disabled = true;
    genBtn.textContent = '加密中…';
    try {
      const displayName = qs<HTMLInputElement>(root, '#nick').value.trim() || '我';
      setDisplayName(displayName);
      const chainOn = isChainEnabled();
      const prev = chainOn ? await lastChain() : null;
      const now = new Date();

      const { pkg, visible, chainRecord } = await pack({
        groups: groups.map((g) => ({
          trip: currentTrip,
          visibility: g.visibility,
          recipientPubkeys: Array.from(g.recipients),
        })),
        senderIdentity: generateIdentityFromSeed(keys.privHex),
        displayName,
        prevChain: prev,
        chainEnabled: chainOn,
        now,
      });

      if (chainRecord) await putChainRecord(chainRecord);

      // 每组每个可见地点落一条自有记忆（Agent 的"个人证据"）
      for (const filtered of visible) {
        for (const item of filtered.visiblePlaces) {
          const photos = item.visiblePhotos.map((vp) => toStorage(new Uint8Array(vp.photo.image)));
          const coverId = item.place.photos[item.place.coverIndex]?.id;
          const foundIndex = item.visiblePhotos.findIndex((vp) => vp.photo.id === coverId);
          await putMemory({
            id: uuid(),
            kind: 'self',
            photos,
            coverIndex: foundIndex >= 0 ? foundIndex : 0,
            tag: item.place.tag,
            intensity: item.place.intensity,
            takenAt: dateNoonIso(item.dayDate),
            placeId: item.place.id,
            placeName: item.place.name || '未命名地点',
            dayDate: item.dayDate,
            ...(item.place.label ? { label: item.place.label } : {}),
            captions: item.visiblePhotos.map((vp) => vp.photo.caption ?? ''),
          });
        }
      }

      lastPackage = pkg;
      download(pkg);
      renderResult(result, pkg, visible, chainOn);
      emitDataChanged();
      toast(`信物已生成并下载（${pkg.groups.length} 组）`);
    } catch (err) {
      console.error(err);
      toast(err instanceof Error ? err.message : '生成失败');
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = '生成信物';
    }
  });

  function download(pkg: SharePackage): void {
    const blob = new Blob([serializePackage(pkg)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = packageFileName(pkg);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  result.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-redownload]');
    if (btn && lastPackage) download(lastPackage);
  });

  renderGroups();
  void refreshFriends();
  void loadTrips();
}

function renderResult(
  el: HTMLDivElement,
  pkg: SharePackage,
  visible: FilterResult[],
  chainOn: boolean,
): void {
  const rows = pkg.groups
    .map((g, i) => {
      const places = g.payload.places.length;
      const photos = g.payload.places.reduce((n, p) => n + p.photos.length, 0);
      const tags = Array.from(new Set(g.payload.places.map((p) => TAG_LABELS[p.tag]))).join('、');
      return `<div class="result-group">
        <span class="badge">组 ${i + 1}</span>
        ${escapeHtml(tags || '（无）')}
        <span class="hint">· ${places} 个地点 · ${photos} 张照片 · ${g.wrappedKeys.length} 人可见</span>
      </div>`;
    })
    .join('');

  const totalPlaces = visible.reduce((n, v) => n + v.visiblePlaces.length, 0);

  el.innerHTML = `
    <div class="spread" style="margin-bottom:10px">
      <strong style="font-size:13px">信物已封好</strong>
      <span class="badge ok">v2026.4</span>
    </div>
    ${rows}
    <dl class="kv" style="margin-top:12px">
      <dt>shareId</dt><dd class="mono">${escapeHtml(pkg.shareId)}</dd>
      <dt>可见地点</dt><dd>${totalPlaces} 个</dd>
      <dt>承诺哈希</dt><dd class="mono">${escapeHtml(shortHex(pkg.commitment.hash, 12, 10))}</dd>
      <dt>链序号</dt><dd class="mono">${chainOn ? pkg.chain.seq : '—（链已关闭）'}</dd>
      <dt>签名</dt><dd class="mono">${escapeHtml(shortHex(pkg.from.sig, 12, 8))}</dd>
    </dl>
    <div class="row">
      <button class="btn ghost sm" data-redownload>重新下载 .trailshare</button>
      <span class="hint">把它发给朋友，让他拖进「导入信物」。</span>
    </div>`;
  el.classList.add('show');
}
