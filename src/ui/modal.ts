/** 通用弹窗。内容由调用方拼好并已转义。 */

let current: HTMLElement | null = null;

export function closeModal(): void {
  if (current) {
    current.remove();
    current = null;
  }
  document.removeEventListener('keydown', onKey);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeModal();
}

export function openModal(title: string, bodyHtml: string): void {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
      <header>
        <h3>${title}</h3>
        <button class="close" aria-label="关闭">×</button>
      </header>
      <div class="body">${bodyHtml}</div>
    </div>`;
  back.addEventListener('click', (e) => {
    if (e.target === back) closeModal();
  });
  back.querySelector('.close')?.addEventListener('click', closeModal);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  current = back;
}
