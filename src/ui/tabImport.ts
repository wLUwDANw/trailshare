/**
 * Tab3 · 导入信物（v2026.4 · 旅程时间线）。
 *
 * 界面不暴露组数：只调 unpackForViewer()，拿不到 pkg，也就没有 totalGroups。
 * 每个解开的组渲染成一条连续时间线（按日期），被屏蔽的条目根本不在包里，
 * 所以既没有占位，也没有"还有 N 天"之类的提示。
 *
 * 接受 = 每个地点落一条 Memory + 一条溯源边（确定性 ID，便于判重）。
 */
import { unpackForViewer, type UnpackView, type UnpackedGroupView, type UnpackedPlace } from '../share/unpack';
import { INTENSITY_MEANING, INTENSITY_STARS, TAG_LABELS } from '../types';
import type { ChainAnchor } from '../types';
import { listChain, appendChainRecord } from '../store/chainStore';
import { putMemory } from '../store/memories';
import { putEdge, listEdges } from '../store/provenance';
import { isChainEnabled } from '../config';
import { toStorage } from '../utils/binary';
import { uuid } from '../utils/id';
import { emitDataChanged } from './bus';
import { escapeHtml, qs, shortHex, toast } from './dom';
import { openModal } from './modal';
import { bytesToDataUrl } from '../utils/image';
import { openPhotoGallery } from './tabLibrary';

interface LoadFailure {
  kind: 'old-version' | 'not-for-you' | 'invalid';
  reason: string;
}

type Outcome = 'accepted' | 'rejected';

function dateNoonIso(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function mountImport(root: HTMLElement): void {
  root.innerHTML = `
    <div class="import-grid">
      <div class="card" style="padding:18px">
        <div class="drop" id="idrop" role="button" tabindex="0" aria-label="选择 .trailshare 文件">
          <div class="placeholder">
            <div style="font-size:22px;line-height:1">✉</div>
            拖入 .trailshare 文件，或点击选择
            <div class="hint" style="margin-top:6px">验证与解密只在本机进行，文件不会上传</div>
          </div>
        </div>
        <input type="file" id="ifile" accept=".trailshare,application/json" hidden />
        <div class="hint" style="margin-top:12px">
          只有发送方选中的收件人才能解开。<br />
          想自己验证隔离效果？开一个无痕窗口当"朋友"，在那边导入同一个文件。
        </div>
      </div>
      <div id="panel"></div>
    </div>
    <p class="hint boundary-note">
      <strong>传播边界</strong>：这是文件级定向，不是内容级不可转发。
      能防住——文件被转发给未授权的人打不开、不同收件人各看各的；
      防不住——授权用户解密后截图、授权用户重新加密转发。
    </p>`;

  const drop = qs<HTMLDivElement>(root, '#idrop');
  const fileInput = qs<HTMLInputElement>(root, '#ifile');
  const panel = qs<HTMLDivElement>(root, '#panel');

  let raw = '';
  let view: UnpackView | null = null;
  let failure: LoadFailure | null = null;
  const outcomes = new Map<string, Outcome>();

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) await load(file);
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) await load(file);
  });

  async function load(file: File): Promise<void> {
    try {
      raw = await file.text();
    } catch {
      toast('读取文件失败');
      return;
    }
    await parse();
  }

  async function parse(): Promise<void> {
    const chainEnabled = isChainEnabled();
    const knownChain = await listChain();
    const res = await unpackForViewer(raw, { chainEnabled, knownChain });

    outcomes.clear();
    if (!res.ok) {
      view = null;
      failure = { kind: res.kind, reason: res.reason };
      render();
      return;
    }

    failure = null;
    const ids = new Set((await listEdges()).map((e) => e.id));
    for (const g of res.groups) {
      if (ids.has(rejectEdgeId(res.shareId, g.groupId))) {
        outcomes.set(g.groupId, 'rejected');
        g.processed = true;
      } else if (g.places.every((p) => ids.has(acceptEdgeId(res.shareId, g.groupId, p.placeId)))) {
        outcomes.set(g.groupId, 'accepted');
        g.processed = true;
      }
    }
    view = res;
    render();
  }

  function render(): void {
    if (!view) {
      renderFailure();
      return;
    }
    const { report, from } = view;
    const allDone = view.groups.every((g) => g.processed);

    const checks = [
      checkItem('结构校验', report.structureOk, report.structureOk ? '字段完整' : '字段缺失或版本不支持'),
      checkItem('Ed25519 签名', report.signatureOk, report.signatureOk ? '内容未被篡改，来源不可抵赖' : '验签失败'),
      checkItem('语义承诺', report.commitmentOk, report.commitmentOk ? '与公开语义一致' : '承诺与内容不一致'),
      checkItem('本地链锚', report.chainOk, report.chainNote),
    ];

    panel.innerHTML = `
      <div class="card verify">
        <div class="spread" style="margin-bottom:14px">
          <strong style="font-size:13px">验证结果</strong>
          <span class="badge ${report.signatureOk && report.structureOk ? 'ok' : 'bad'}">
            ${report.signatureOk && report.structureOk ? '签名有效' : '未通过'}
          </span>
        </div>
        <ul class="checks">${checks.join('')}</ul>
        <dl class="kv" style="margin:14px 0 0">
          <dt>来自</dt><dd>${escapeHtml(from.displayName)} <span class="mono">（${escapeHtml(shortHex(from.pubkey, 8, 4))}）</span></dd>
          <dt>承诺</dt><dd class="mono">${escapeHtml(shortHex(view.commitment, 10, 8))}</dd>
        </dl>
        <div class="row" style="margin-top:12px">
          <button class="btn ghost sm" id="details">查看验证详情</button>
        </div>
        ${allDone ? '<div class="notice ok" style="margin-top:12px">这份信物已全部处理完毕。</div>' : ''}
      </div>
      ${view.groups.map((g) => groupCard(g)).join('')}`;

    bindGroupActions();
    root.querySelector<HTMLButtonElement>('#details')?.addEventListener('click', () => showDetails());
  }

  function timelineHtml(places: UnpackedPlace[]): string {
    const dates: string[] = [];
    for (const p of places) if (!dates.includes(p.date)) dates.push(p.date);

    return dates
      .map(
        (date) => `<section class="timeline-day">
          <h4 class="timeline-date">${escapeHtml(date)}</h4>
          ${places.filter((p) => p.date === date).map((p) => placeHtml(p)).join('')}
        </section>`,
      )
      .join('');
  }

  function placeHtml(place: UnpackedPlace): string {
    const images = place.photos.map((p) => {
      try {
        return bytesToDataUrl(new Uint8Array(p.data));
      } catch {
        return '';
      }
    });

    return `<article class="timeline-place" data-place="${escapeHtml(place.placeId)}">
      <div class="timeline-place-head">
        <span class="timeline-place-name">${escapeHtml([place.label, place.name].filter(Boolean).join(' · '))}</span>
      </div>
      <div class="timeline-place-meta">${TAG_LABELS[place.tag]} · ${INTENSITY_STARS[place.intensity]} ${INTENSITY_MEANING[place.intensity]}</div>
      <div class="timeline-photos">
        ${place.photos
          .map(
            (_, i) => `<figure class="timeline-photo">
              <img src="${images[i]}" alt="第 ${i + 1} 张" loading="lazy"
                data-photo="${escapeHtml(place.placeId)}:${i}" />
              ${place.photos[i].caption ? `<figcaption class="timeline-caption">${escapeHtml(place.photos[i].caption ?? '')}</figcaption>` : ''}
            </figure>`,
          )
          .join('')}
      </div>
    </article>`;
  }

  function groupCard(g: UnpackedGroupView): string {
    const outcome = outcomes.get(g.groupId);
    const actions = outcome
      ? `<div class="notice ok" style="margin-top:12px">${outcome === 'accepted' ? '已接受这段旅程' : '已拒绝这段旅程'}</div>`
      : `<div class="row" style="margin-top:12px">
           <button class="btn seal sm" data-accept="${escapeHtml(g.groupId)}" ${view?.canAccept ? '' : 'disabled'}>接受这段旅程</button>
           <button class="btn ghost sm" data-reject="${escapeHtml(g.groupId)}">拒绝</button>
         </div>`;

    return `<div class="card group-result" data-card="${escapeHtml(g.groupId)}">
      <div style="margin-bottom:10px"><strong style="font-size:13px">来自：${escapeHtml(g.fromName)}</strong></div>
      <div class="timeline">${timelineHtml(g.places)}</div>
      ${actions}
    </div>`;
  }

  function bindGroupActions(): void {
    if (!view) return;

    root.querySelectorAll<HTMLImageElement>('[data-photo]').forEach((img) => {
      img.addEventListener('click', () => {
        const [placeId, index] = (img.dataset.photo ?? '').split(':');
        for (const g of view?.groups ?? []) {
          const place = g.places.find((p) => p.placeId === placeId);
          if (!place) continue;
          const images = place.photos.map((p) => {
            try {
              return bytesToDataUrl(new Uint8Array(p.data));
            } catch {
              return '';
            }
          });
          openPhotoGallery(`${escapeHtml(place.name)} 的照片`, images, Number(index));
          return;
        }
      });
    });

    root.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const g = view?.groups.find((x) => x.groupId === btn.dataset.accept);
        if (g) void acceptGroup(g);
      });
    });

    root.querySelectorAll<HTMLButtonElement>('[data-reject]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const g = view?.groups.find((x) => x.groupId === btn.dataset.reject);
        if (g) void rejectGroup(g);
      });
    });
  }

  function renderFailure(): void {
    if (!failure) {
      panel.innerHTML = '';
      return;
    }
    const title =
      failure.kind === 'old-version' ? '版本过旧' : failure.kind === 'not-for-you' ? '不是给你的' : '无法读取';
    const tip =
      failure.kind === 'old-version'
        ? '当前只支持 ts-2026.4 格式，只能请对方用新版重新生成一次。'
        : failure.kind === 'not-for-you'
          ? '只有发送方选中的收件人才能解开。转发给别人，别人也看不到任何内容。'
          : '文件可能已损坏，或者不是 TrailShare 信物。';
    panel.innerHTML = `
      <div class="card verify">
        <div class="spread" style="margin-bottom:12px">
          <strong style="font-size:13px">无法读取</strong>
          <span class="badge bad">${escapeHtml(title)}</span>
        </div>
        <p class="say" style="margin:0 0 10px">${escapeHtml(failure.reason)}</p>
        <p class="hint" style="margin:0">${escapeHtml(tip)}</p>
      </div>`;
  }

  async function acceptGroup(g: UnpackedGroupView): Promise<void> {
    if (!view) return;
    const now = new Date();
    const existing = new Set((await listEdges()).map((e) => e.id));

    try {
      if (isChainEnabled()) {
        await appendChainRecord('share_accepted', g.shareId, view.signature, now.toISOString());
      }

      for (const place of g.places) {
        const edgeId = acceptEdgeId(g.shareId, g.groupId, place.placeId);
        if (existing.has(edgeId)) continue;

        const memoryId = uuid();
        const photos = place.photos.map((p) => toStorage(p.data));
        const captions = place.photos.map((p) => p.caption ?? '');

        await putMemory({
          id: memoryId,
          kind: 'gift',
          photos,
          coverIndex: 0,
          tag: place.tag,
          intensity: place.intensity,
          takenAt: dateNoonIso(place.date),
          placeId: place.placeId,
          placeName: place.name,
          dayDate: place.date,
          ...(place.label ? { label: place.label } : {}),
          captions,
          shareId: g.shareId,
          fromPubkey: g.fromPubkey,
          fromName: g.fromName,
          acceptedAt: now.toISOString(),
        });

        let chainAnchor: ChainAnchor | null = null;
        if (isChainEnabled()) {
          const rec = await appendChainRecord('share_accepted', g.shareId, view.signature, now.toISOString());
          chainAnchor = { type: 'local', seq: rec.seq, prevHash: rec.prevHash, hash: rec.hash };
        }

        await putEdge({
          id: edgeId,
          memoryId,
          shareId: g.shareId,
          fromPubkey: g.fromPubkey,
          fromName: g.fromName,
          commitment: view.commitment,
          signature: view.signature,
          chainAnchor,
          verified: view.report.signatureOk && view.report.commitmentOk === true,
          acceptedAt: now.toISOString(),
        });
      }

      outcomes.set(g.groupId, 'accepted');
      g.processed = true;
      emitDataChanged();
      render();
      toast('已接受这段旅程');
    } catch (err) {
      console.error(err);
      toast('写入失败');
    }
  }

  async function rejectGroup(g: UnpackedGroupView): Promise<void> {
    if (!view) return;
    const now = new Date();
    const id = rejectEdgeId(g.shareId, g.groupId);
    try {
      if ((await listEdges()).some((e) => e.id === id)) {
        outcomes.set(g.groupId, 'rejected');
        g.processed = true;
        render();
        return;
      }
      if (isChainEnabled()) {
        await appendChainRecord('share_rejected', g.shareId, view.signature, now.toISOString());
      }
      await putEdge({
        id,
        memoryId: '',
        shareId: g.shareId,
        fromPubkey: g.fromPubkey,
        fromName: g.fromName,
        commitment: view.commitment,
        signature: view.signature,
        chainAnchor: null,
        verified: false,
        acceptedAt: now.toISOString(),
        rejected: true,
      });
      outcomes.set(g.groupId, 'rejected');
      g.processed = true;
      emitDataChanged();
      render();
      toast('已拒绝这段旅程；这会降低对方的信任分');
    } catch (err) {
      console.error(err);
      toast('写入失败');
    }
  }

  function showDetails(): void {
    if (!view) return;
    const { report } = view;
    const body = `
      <dl class="kv">
        <dt>shareId</dt><dd class="mono">${escapeHtml(view.shareId)}</dd>
        <dt>发件人</dt><dd>${escapeHtml(view.from.displayName)}</dd>
        <dt>公钥</dt><dd class="mono">${escapeHtml(view.from.pubkey)}</dd>
        <dt>承诺</dt><dd class="mono">${escapeHtml(view.commitment)}</dd>
        <dt>链</dt><dd class="mono">seq=${view.chainSeq} · prev=${escapeHtml(shortHex(view.chainPrevHash, 10, 6))}</dd>
        <dt>签名</dt><dd class="mono">${escapeHtml(view.signature)}</dd>
      </dl>
      <h4 style="font-size:13px;margin:16px 0 8px">验证报告</h4>
      <ul class="checks">${[
        checkItem('结构校验', report.structureOk, ''),
        checkItem('签名', report.signatureOk, ''),
        checkItem('承诺', report.commitmentOk, ''),
        checkItem('链锚', report.chainOk, report.chainNote),
      ].join('')}</ul>
      <p class="hint" style="margin:14px 0 0">
        详情只列这个信物的公开字段；不展示组数与地点总数。
      </p>`;
    openModal('验证详情', body);
  }
}

/** 确定性边 ID：一个地点一条，便于判重。 */
function acceptEdgeId(shareId: string, groupId: string, placeId: string): string {
  return `e_${shareId}_${groupId}_${placeId}`;
}

function rejectEdgeId(shareId: string, groupId: string): string {
  return `e_${shareId}_${groupId}_rej`;
}

function checkItem(label: string, ok: boolean | null, note: string): string {
  const cls = ok === true ? 'ok' : ok === false ? 'bad' : 'warn';
  const mark = ok === true ? '✓' : ok === false ? '✗' : '·';
  return `<li><span class="badge ${cls}" style="min-width:22px;justify-content:center">${mark}</span>
    <span><strong style="font-weight:550">${escapeHtml(label)}</strong>
    <span class="note">${escapeHtml(note)}</span></span></li>`;
}
