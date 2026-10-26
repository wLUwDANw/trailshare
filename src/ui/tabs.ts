/** Tab 切换。无路由库，靠 data-tab + display 切换。 */

export type TabName = 'trips' | 'library' | 'create' | 'import' | 'friends';

type Hook = () => void;

const hooks: Record<TabName, Hook[]> = { trips: [], library: [], create: [], import: [], friends: [] };

export function onTabShow(tab: TabName, fn: Hook): void {
  hooks[tab].push(fn);
}

export function showTab(tab: TabName): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
  });
  document.querySelectorAll<HTMLElement>('.panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${tab}`);
  });
  for (const fn of hooks[tab]) fn();
}

export function setupTabs(initial: TabName = 'trips'): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab as TabName;
      if (tab) showTab(tab);
    });
  });
  showTab(initial);
}
