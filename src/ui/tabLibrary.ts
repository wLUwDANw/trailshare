/**
 * Tab2 · 记忆库：时间线 + 逐张评星 + 溯源问答。
 *
 * 展示模型：一条 Memory = 一个地点（v2026.4 起），按 dayDate 归到天。
 * 评星只存在本地 Memory.ratings 里，不随信物传递；它通过 ratingAdapter 影响 fuse 的输入，
 * fuse.ts 本身一行未改。
 */
import { fuse, DEFAULT_FUSE_CONFIG, normalizeScores } from '../agent/fuse';
import { rankTags } from '../agent/recommend';
import { explainWithLLM } from '../agent/explain';
import { faithfulness } from '../agent/counterfactual';
import { adaptEdgesForFuse } from '../agent/ratingAdapter';
import { listMemories, photosOf, deleteMemory } from '../store/memories';
import { listEdges } from '../store/provenance';
import { setPhotoRating } from '../store/ratings';
import { INTENSITY_MEANING, INTENSITY_STARS, TAG_LABELS } from '../types';
import type { FuseInput, Memory, ProvenanceEdge } from '../types';
import { emitDataChanged, onDataChanged } from './bus';
import { escapeHtml, toast } from './dom';
import { closeModal, openModal } from './modal';
import { bytesToDataUrl } from '../utils/image';

export function mountLibrary(root: HTMLElement): void {
  root.innerHTML = `
    <form class="searchbar" id="ask">
      <input type="text" id="q" placeholder="为什么推荐我去自然风光？" autocomplete="off" />
      <button class="btn" type="submit">问 Agent</button>
    </form>
    <div id="answerSlot"></div>
    <div id="timeline" class="timeline"></div>`;

  const answerSlot = root.querySelector<HTMLDivElement>('#answerSlot')!;
  const timeline = root.querySelector<HTMLDivElement>('#timeline')!;
  const input = root.querySelector<HTMLInputElement>('#q')!;

  let memories: Memory[] = [];
  let edges: ProvenanceEdge[] = [];

  function dayOf(m: Memory): string {
    if (m.dayDate) return m.dayDate;
    return (m.takenAt ?? '').slice(0, 10);
  }

  async function refresh(): Promise<void> {
    [memories, edges] = await Promise.all([listMemories(), listEdges()]);

    if (memories.length === 0) {
      timeline.innerHTML = `<div class="empty card" style="padding:48px 20px">
        <h3>还没有记忆</h3>
        去「旅程」整理一次旅行并生成信物，或者从朋友那里「导入信物」。
      </div>`;
      return;
    }

    // 按日期正序，像一条时间线；同一天保持原有顺序
    const ordered = memories
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const da = dayOf(a.m);
        const db = dayOf(b.m);
        if (da === db) return a.i - b.i;
        return da < db ? -1 : 1;
      })
      .map((x) => x.m);

    const days: string[] = [];
    for (const m of ordered) {
      const d = dayOf(m);
      if (!days.includes(d)) days.push(d);
    }

    timeline.innerHTML = days
      .map(
        (date) => `<section class="timeline-day">
          <h4 class="timeline-date">${escapeHtml(date || '未知日期')}</h4>
          ${ordered.filter((m) => dayOf(m) === date).map((m) => placeHtml(m)).join('')}
        </section>`,
      )
      .join('');

    bindTimeline();
  }

  function placeHtml(m: Memory): string {
    const photos = photosOf(m);
    const images = photos.map((p) => {
      try {
        return bytesToDataUrl(new Uint8Array(p));
      } catch {
        return '';
      }
    });
    const title = [m.label, m.placeName].filter(Boolean).join(' · ') || TAG_LABELS[m.tag];
    const gift =
      m.kind === 'gift'
        ? `<span class="badge ok" style="white-space:nowrap">👤 ${escapeHtml(m.fromName ?? '朋友')} ✓</span>`
        : '<span class="badge" style="white-space:nowrap">自有</span>';

    return `<article class="timeline-place" data-id="${escapeHtml(m.id)}">
      <div class="timeline-place-head">
        <span class="timeline-place-name">${escapeHtml(title)}</span>
        ${gift}
        <button type="button" class="trip-del" data-del="${escapeHtml(m.id)}" title="删除这条记忆" aria-label="删除这条记忆">×</button>
      </div>
      <div class="timeline-place-meta">
        ${TAG_LABELS[m.tag]} · ${INTENSITY_STARS[m.intensity]} ${INTENSITY_MEANING[m.intensity]}
      </div>
      <div class="timeline-photos">
        ${photos
          .map((_, i) => {
            const rating = m.ratings?.[i] ?? null;
            return `<figure class="timeline-photo">
              <img src="${images[i]}" alt="第 ${i + 1} 张" loading="lazy" data-open="${escapeHtml(m.id)}:${i}" />
              ${m.captions?.[i] ? `<figcaption class="timeline-caption">${escapeHtml(m.captions[i])}</figcaption>` : ''}
              <div class="rating-row" data-rating="${escapeHtml(m.id)}:${i}">
                ${[1, 2, 3, 4, 5]
                  .map(
                    (s) =>
                      `<button type="button" class="rating-star${rating !== null && s <= rating ? ' on' : ''}"
                        data-score="${s}" title="${s} 星" aria-label="${s} 星">★</button>`,
                  )
                  .join('')}
                <span class="rating-hint">${rating === null ? '未评' : `${rating} 星`}</span>
              </div>
            </figure>`;
          })
          .join('')}
      </div>
    </article>`;
  }

  function bindTimeline(): void {
    timeline.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = memories.find((x) => x.id === btn.dataset.del);
        if (m) confirmDelete(m);
      });
    });

    timeline.querySelectorAll<HTMLImageElement>('[data-open]').forEach((img) => {
      img.addEventListener('click', () => {
        const [id, index] = (img.dataset.open ?? '').split(':');
        const m = memories.find((x) => x.id === id);
        if (!m) return;
        const urls = photosOf(m).map((p) => {
          try {
            return bytesToDataUrl(new Uint8Array(p));
          } catch {
            return '';
          }
        });
        openPhotoGallery(`${escapeHtml(m.placeName ?? TAG_LABELS[m.tag])} 的照片`, urls, Number(index));
      });
    });

    timeline.querySelectorAll<HTMLElement>('[data-rating]').forEach((row) => {
      const id = (row.dataset.rating ?? '').split(':')[0];
      const index = Number((row.dataset.rating ?? '').split(':')[1]);
      row.querySelectorAll<HTMLButtonElement>('[data-score]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const m = memories.find((x) => x.id === id);
          if (!m) return;
          const score = Number(btn.dataset.score);
          const current = m.ratings?.[index] ?? null;
          try {
            await setPhotoRating(id, index, current === score ? null : score);
            emitDataChanged();
          } catch (err) {
            console.error(err);
            toast('评星失败');
          }
        });
      });
    });
  }

  /**
   * 删除确认：删什么、边会一起删、链记录不动。
   * 删除后清空当前回答——那段文字引用的来源边已经没了。
   */
  function confirmDelete(m: Memory): void {
    const related = edges.filter((e) => e.memoryId === m.id).length;
    const origin = m.kind === 'gift' ? `${m.fromName ?? '朋友'}（朋友分享）` : '自己拍摄';
    const body = `
      <dl class="kv" style="margin:0 0 14px">
        <dt>来源</dt><dd>${escapeHtml(origin)}</dd>
        <dt>地点</dt><dd>${escapeHtml(m.placeName ?? TAG_LABELS[m.tag])}</dd>
        <dt>标签</dt><dd>${TAG_LABELS[m.tag]} · ${INTENSITY_STARS[m.intensity]} ${INTENSITY_MEANING[m.intensity]}</dd>
      </dl>
      <ul style="margin:0 0 16px;padding-left:18px;font-size:13px;line-height:1.9;color:var(--ink-2)">
        <li>记忆本身与它的评星会被删除</li>
        <li>关联的 ${related} 条溯源边会被删除</li>
        <li>链记录会保留（链的不可变性）</li>
        <li>之后的反事实检验将不再引用这条来源</li>
      </ul>
      <div class="row" style="justify-content:flex-end;margin-top:4px">
        <button type="button" class="btn ghost sm" id="cancel-del">取消</button>
        <button type="button" class="btn seal sm" id="confirm-del">确认删除</button>
      </div>`;

    openModal('确认删除这条记忆？', body);
    document.getElementById('cancel-del')?.addEventListener('click', closeModal);
    document.getElementById('confirm-del')?.addEventListener('click', async () => {
      try {
        await deleteMemory(m.id);
        closeModal();
        answerSlot.innerHTML = '';
        toast('已删除；链记录未变动');
        emitDataChanged();
      } catch (err) {
        console.error(err);
        toast('删除失败');
      }
    });
  }

  /** fuse 的输入：边先经过评星适配（低分记忆的边按 rejected 处理）。 */
  function currentInput(): FuseInput {
    return {
      memories,
      edges: adaptEdgesForFuse(edges, memories),
      now: new Date(),
      config: DEFAULT_FUSE_CONFIG,
    };
  }

  root.querySelector<HTMLFormElement>('#ask')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    if (memories.length === 0) {
      toast('记忆库是空的，先去生成或导入一条信物');
      return;
    }
    void renderAnswer(question);
  });

  async function renderAnswer(question: string): Promise<void> {
    const fuseInput = currentInput();
    const fuseOut = fuse(fuseInput);
    const fuseEdges = fuseInput.edges;
    // LLM 只在这里参与：解析问题 + 润色表达；排序与引用仍由规则逻辑决定
    const explanation = await explainWithLLM(question, fuseOut, memories, fuseEdges);
    const ranking = rankTags(fuseOut, 3);
    const normalized = normalizeScores(fuseOut.scores);

    if (explanation.citedEdgeIds.length === 0 && explanation.citedMemoryIds.length === 0) {
      answerSlot.innerHTML = `<div class="card answer">
        <p class="say">${escapeHtml(explanation.answer)}</p>
        <div class="hint">当前排行榜：${ranking.map((t) => TAG_LABELS[t]).join(' · ') || '（空）'}</div>
      </div>`;
      return;
    }

    const citedEdges = explanation.citedEdgeIds
      .map((id) => fuseEdges.find((e) => e.id === id))
      .filter((e): e is ProvenanceEdge => Boolean(e));

    const citesHtml = citedEdges
      .map((e) => {
        const marks = [
          `<span class="badge ${e.verified ? 'ok' : 'warn'}">签名 ${e.verified ? '✓' : '?'}</span>`,
          `<span class="badge ${e.chainAnchor ? 'ok' : ''}">链 ${e.chainAnchor ? '✓' : '—'}</span>`,
        ].join('');
        return `<li><span class="mono">${escapeHtml(e.shareId)}</span> 来自 ${escapeHtml(e.fromName)}，
          ${escapeHtml(TAG_LABELS[memories.find((m) => m.id === e.memoryId)?.tag ?? 'nature'])} ${marks}</li>`;
      })
      .join('');

    const answerHtml = escapeHtml(explanation.answer).replace(
      /\[gift:([^\]]+)\]/g,
      '<span class="gift-ref">$1</span>',
    );

    const ruleBadge =
      explanation.llmConfigured && !explanation.usedLLM
        ? `<span class="badge warn" style="margin-left:8px" title="${escapeHtml(explanation.fallbackReason ?? '')}">规则版回答</span>`
        : '';

    answerSlot.innerHTML = `<div class="card answer">
      <p class="say" style="white-space:pre-wrap">${answerHtml}</p>
      <div class="hint" style="margin-bottom:10px">
        当前排行榜：${ranking
          .map((t) => `${TAG_LABELS[t]} ${(normalized[t] * 100).toFixed(0)}%`)
          .join(' · ')}${ruleBadge}
      </div>
      ${citedEdges.length > 0 ? `<ul class="cites">${citesHtml}</ul>` : ''}
      <div class="cf" id="cf">
        <button class="btn ghost sm" id="cfBtn">反事实检验：把这些来源拿掉会怎样？</button>
        <div id="cfOut" style="margin-top:12px"></div>
      </div>
    </div>`;

    const cfBtn = answerSlot.querySelector<HTMLButtonElement>('#cfBtn');
    cfBtn?.addEventListener('click', () => {
      const cfOut = answerSlot.querySelector<HTMLDivElement>('#cfOut')!;
      if (explanation.citedEdgeIds.length === 0) {
        cfOut.innerHTML = `<div class="hint">这条解释只引用了你自己的记忆，没有社会边可以移除。移除个人记忆等于否认你拍过这张照片，不做这种反事实。</div>`;
        return;
      }
      const result = faithfulness(explanation, fuseInput);
      cfOut.innerHTML = `
        <div class="flow">
          <span class="hint">移除前</span>
          ${result.before.map((t) => `<span class="pill">${TAG_LABELS[t]}</span>`).join('')}
          <span class="hint">→ 移除后</span>
          ${result.after.map((t) => `<span class="pill">${TAG_LABELS[t]}</span>`).join('')}
          <span class="badge ${result.flipped ? 'ok' : 'bad'}">${result.flipped ? '翻转了 ✓ 解释忠实' : '没变 ✗ 解释不忠实'}</span>
        </div>
        <div class="hint">
          ${result.flipped
            ? '拿掉这些来源后推荐确实变了，说明"这条偏好来自他们"不是事后编的。'
            : '拿掉这些来源后推荐没变，说明它并不是这次决策的决定性依据（可能你自己的记忆已经主导）。'}
        </div>`;
      cfOut.querySelector('.flow')?.scrollIntoView({ block: 'nearest' });
    });
  }

  onDataChanged(() => {
    void refresh();
  });
  void refresh();
}

/**
 * 照片轮播。导入页、记忆库共用。
 * 传进来的必须是 data URL：弹窗没有关闭回调，用对象 URL 会漏掉 revoke。
 */
export function openPhotoGallery(title: string, images: string[], start = 0): void {
  if (images.length === 0) return;
  let index = Math.min(Math.max(0, start), images.length - 1);

  const view = (): string => `
    <div style="position:relative">
      <img src="${images[index]}" alt="第 ${index + 1} 张" style="width:100%;border-radius:8px;display:block" />
      <div style="position:absolute;right:8px;bottom:8px;background:rgba(34,29,24,.72);color:#fff;font-size:12px;line-height:1.8;padding:0 9px;border-radius:999px">${index + 1} / ${images.length}</div>
    </div>
    ${
      images.length > 1
        ? `<div class="row" style="justify-content:center;margin-top:12px">
             <button class="btn ghost sm" data-nav="-1" ${index === 0 ? 'disabled' : ''}>上一张</button>
             <button class="btn ghost sm" data-nav="1" ${index === images.length - 1 ? 'disabled' : ''}>下一张</button>
           </div>
           <div class="row" style="justify-content:center;margin-top:10px;gap:6px">
             ${images
               .map(
                 (url, i) =>
                   `<button data-jump="${i}" title="第 ${i + 1} 张" style="padding:0;width:52px;height:52px;border-radius:6px;overflow:hidden;background:none;border:2px solid ${
                     i === index ? 'var(--seal)' : 'var(--line)'
                   }"><img src="${url}" alt="第 ${i + 1} 张" style="width:100%;height:100%;object-fit:cover;display:block" /></button>`,
               )
               .join('')}
           </div>`
        : ''
    }`;

  openModal(title, view());
  const body = document.querySelector<HTMLElement>('.modal .body');
  if (!body) return;

  const paint = (): void => {
    body.innerHTML = view();
    body.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        index = Math.min(images.length - 1, Math.max(0, index + Number(btn.dataset.nav)));
        paint();
      });
    });
    body.querySelectorAll<HTMLButtonElement>('[data-jump]').forEach((btn) => {
      btn.addEventListener('click', () => {
        index = Number(btn.dataset.jump);
        paint();
      });
    });
  };
  paint();
}
