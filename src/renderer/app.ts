/**
 * Noir Browser — renderer оболочки (вкладки, омнибокс, стартовая страница, ИИ-чат).
 * Общение с main — только через window.noir (preload, contextIsolation).
 * Файл намеренно без runtime-импортов: только import type, который стирается при компиляции.
 */
import type { NoirApi, TabsState, TabInfo, AdblockStatus, AiSettings, AiProvider } from '../shared/protocol';

declare global {
  interface Window {
    noir: NoirApi;
  }
}

const noir = window.noir;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const tabsEl = $('tabs');
const omnibox = $<HTMLInputElement>('omnibox');
const btnBack = $<HTMLButtonElement>('btn-back');
const btnForward = $<HTMLButtonElement>('btn-forward');
const btnReload = $<HTMLButtonElement>('btn-reload');
const iconReload = $('icon-reload');
const iconStop = $('icon-stop');
const lockIcon = $('lock-icon');
const progress = $('progress');
const newtabEl = $('newtab');
const shieldBtn = $<HTMLButtonElement>('btn-shield');
const shieldBadge = $('shield-badge');
const shieldPopover = $('shield-popover');
const shieldToggle = $<HTMLInputElement>('shield-toggle');
const shieldStatusText = $('shield-status-text');
const shieldCount = $('shield-count');
const aiSidebar = $('ai-sidebar');
const aiMessages = $('ai-messages');
const aiInput = $<HTMLInputElement>('ai-input');
const aiSend = $<HTMLButtonElement>('ai-send');
const aiCancel = $<HTMLButtonElement>('ai-cancel');
const btnAi = $<HTMLButtonElement>('btn-ai');

let tabsState: TabsState = { tabs: [], activeId: -1 };
let omniboxEditing = false;
let lastActiveId = -1;
let sidebarOpen = false;
let aiBusy = false;

// ---------------- Тема (по умолчанию — тёмная) ----------------
const savedTheme = localStorage.getItem('noir-theme');
if (savedTheme === 'light') document.documentElement.dataset.theme = 'light';
$('btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  if (next === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  localStorage.setItem('noir-theme', next);
});

// ---------------- Окно ----------------
$('win-min').addEventListener('click', () => noir.minimizeWindow());
$('win-max').addEventListener('click', () => noir.maximizeWindow());
$('win-close').addEventListener('click', () => noir.closeWindow());

// ---------------- Вкладки ----------------
function activeTab(): TabInfo | undefined {
  return tabsState.tabs.find((t) => t.id === tabsState.activeId);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function renderTabs(): void {
  tabsEl.textContent = '';
  for (const tab of tabsState.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === tabsState.activeId ? ' active' : '');
    el.title = tab.title + (tab.url && !tab.isNewTab ? '\n' + tab.url : '');

    if (tab.loading) {
      const sp = document.createElement('span');
      sp.className = 'spinner';
      el.append(sp);
    } else if (tab.favicon) {
      const img = document.createElement('img');
      img.className = 'favicon';
      img.src = tab.favicon;
      img.alt = '';
      img.addEventListener('error', () => img.remove());
      el.append(img);
    } else {
      const fb = document.createElement('span');
      fb.className = 'favicon-fallback';
      fb.textContent = (tab.isNewTab ? 'N' : hostOf(tab.url).charAt(0) || '•').toUpperCase();
      el.append(fb);
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || 'Новая вкладка';
    el.append(title);

    const close = document.createElement('button');
    close.className = 'close';
    close.title = 'Закрыть вкладку';
    close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      void noir.closeTab(tab.id);
    });
    el.append(close);

    el.addEventListener('click', () => void noir.activateTab(tab.id));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) void noir.closeTab(tab.id); // средняя кнопка мыши
    });
    tabsEl.append(el);
  }
}

function renderChrome(): void {
  const tab = activeTab();
  renderTabs();

  // Омнибокс: не перетираем текст, пока пользователь печатает (кроме смены вкладки).
  const tabSwitched = tabsState.activeId !== lastActiveId;
  lastActiveId = tabsState.activeId;
  if (!omniboxEditing || tabSwitched) {
    omnibox.value = !tab || tab.isNewTab ? '' : tab.url;
  }

  btnBack.disabled = !(tab?.canGoBack ?? false);
  btnForward.disabled = !(tab?.canGoForward ?? false);
  const loading = tab?.loading ?? false;
  iconReload.hidden = loading;
  iconStop.hidden = !loading;
  btnReload.title = loading ? 'Остановить загрузку' : 'Обновить';
  progress.className = loading ? 'loading' : '';
  if (!loading) {
    progress.style.width = '100%';
    setTimeout(() => (progress.style.width = '0'), 250);
  }

  const secure = !!tab && !tab.isNewTab && tab.url.startsWith('https://');
  lockIcon.className = secure ? '' : 'insecure';
  lockIcon.title = tab?.isNewTab ? 'Стартовая страница Noir' : secure ? 'Защищённое соединение (HTTPS)' : 'Соединение';

  newtabEl.hidden = !(tab?.isNewTab ?? false);
}

noir.onTabsState((state) => {
  tabsState = state;
  renderChrome();
});
noir.onFocusOmnibox(() => {
  const tab = activeTab();
  if (tab?.isNewTab && !newtabEl.hidden) $('nt-search').focus();
  else {
    omnibox.focus();
    omnibox.select();
  }
});

$('new-tab-btn').addEventListener('click', () => void noir.createTab());
tabsEl.addEventListener('dblclick', (e) => {
  if (e.target === tabsEl) void noir.createTab();
});

// ---------------- Навигация ----------------
btnBack.addEventListener('click', () => void noir.goBack());
btnForward.addEventListener('click', () => void noir.goForward());
btnReload.addEventListener('click', () => void (activeTab()?.loading ? noir.stop() : noir.reload()));
$('btn-home').addEventListener('click', () => void noir.goHome());

omnibox.addEventListener('focus', () => {
  omniboxEditing = true;
  omnibox.select();
});
omnibox.addEventListener('blur', () => {
  omniboxEditing = false;
  renderChrome();
});
omnibox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const value = omnibox.value.trim();
    if (value) void noir.navigate(value);
    omnibox.blur();
  } else if (e.key === 'Escape') {
    omnibox.blur();
  }
});

// ---------------- Блокировщик рекламы ----------------
function renderAdblock(status: AdblockStatus): void {
  shieldBtn.className = status.enabled && status.ready ? 'on' : status.enabled ? '' : 'off';
  shieldBtn.title = status.enabled
    ? status.ready
      ? `Блокировщик включён · заблокировано: ${status.blockedTotal}`
      : 'Блокировщик загружается…'
    : 'Блокировщик выключен';
  shieldBadge.textContent = String(status.blockedTotal > 99 ? '99+' : status.blockedTotal);
  shieldBadge.className = status.blockedTotal > 0 && status.enabled ? 'show' : '';
  shieldToggle.checked = status.enabled;
  shieldCount.textContent = String(status.blockedTotal);
  shieldStatusText.textContent = !status.enabled
    ? '⚠️ Выключено — реклама и трекеры не фильтруются'
    : status.ready
      ? '✅ Активно: реклама и трекеры блокируются'
      : '⏳ Загружаю фильтры EasyList…';
  shieldStatusText.className = 'pop-status ' + (status.enabled && status.ready ? 'ok' : 'warn');
  $('nt-adblock-text').textContent = status.enabled
    ? status.ready
      ? `Блокировщик активен. За сессию остановлено запросов: ${status.blockedTotal}.`
      : 'Блокировщик загружает фильтры…'
    : 'Блокировщик сейчас выключен. Включите его кнопкой-щитом в адресной строке.';
}
noir.onAdblockStatus(renderAdblock);
void noir.getAdblockStatus().then(renderAdblock).catch(() => undefined);

shieldBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  shieldPopover.hidden = !shieldPopover.hidden;
});
document.addEventListener('click', (e) => {
  if (!shieldPopover.hidden && !shieldPopover.contains(e.target as Node)) shieldPopover.hidden = true;
});
shieldToggle.addEventListener('change', () => {
  void noir.setAdblockEnabled(shieldToggle.checked).then(renderAdblock);
});

// ---------------- Стартовая страница ----------------
const SHORTCUTS: Array<{ name: string; url: string; color: string }> = [
  { name: 'YouTube', url: 'https://www.youtube.com', color: '#ff0033' },
  { name: 'GitHub', url: 'https://github.com', color: '#333a45' },
  { name: 'Wikipedia', url: 'https://ru.wikipedia.org', color: '#5a5a66' },
  { name: 'DuckDuckGo', url: 'https://duckduckgo.com', color: '#de5833' },
  { name: 'Хабр', url: 'https://habr.com', color: '#4a7fb5' },
  { name: 'VK Видео', url: 'https://vkvideo.ru', color: '#0077ff' },
  { name: 'Дзен', url: 'https://dzen.ru', color: '#f5c400' },
  { name: 'Example', url: 'https://example.com', color: '#7a4fd0' },
];
const shortcutsEl = $('nt-shortcuts');
for (const s of SHORTCUTS) {
  const tile = document.createElement('button');
  tile.className = 'nt-tile';
  const letter = document.createElement('div');
  letter.className = 'tile-letter';
  letter.style.background = s.color;
  letter.textContent = s.name.charAt(0);
  const name = document.createElement('div');
  name.className = 'tile-name';
  name.textContent = s.name;
  tile.append(letter, name);
  tile.addEventListener('click', () => void noir.navigate(s.url));
  shortcutsEl.append(tile);
}

function tickClock(): void {
  const now = new Date();
  $('nt-clock').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const h = now.getHours();
  $('nt-greeting').textContent =
    h < 5 ? 'Тихая ночь. Самое время для интернета без рекламы 🌑'
    : h < 12 ? 'Доброе утро'
    : h < 18 ? 'Добрый день'
    : 'Добрый вечер';
}
tickClock();
setInterval(tickClock, 20_000);

$<HTMLFormElement>('nt-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $<HTMLInputElement>('nt-search').value.trim();
  if (v) void noir.navigate(v);
});
$('nt-test-adblock').addEventListener('click', () => void noir.createTab('https://adblock-tester.com/'));
$('nt-open-ai').addEventListener('click', () => setSidebar(true));

// ---------------- ИИ-агент ----------------
const PROVIDER_DEFAULTS: Record<AiProvider, { model: string; baseUrl: string }> = {
  local: { model: '', baseUrl: '' },
  ollama: { model: 'llama3.1', baseUrl: 'http://localhost:11434' },
  groq: { model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
  openrouter: { model: 'meta-llama/llama-3.3-70b-instruct:free', baseUrl: 'https://openrouter.ai/api/v1' },
  custom: { model: '', baseUrl: 'http://localhost:1234/v1' },
};

function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem('noir-ai-settings');
    if (raw) return { provider: 'local', apiKey: '', model: '', baseUrl: '', ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { provider: 'local', apiKey: '', model: '', baseUrl: '' };
}

const providerSel = $<HTMLSelectElement>('ai-provider');
const apiKeyInput = $<HTMLInputElement>('ai-apikey');
const modelInput = $<HTMLInputElement>('ai-model');
const baseUrlInput = $<HTMLInputElement>('ai-baseurl');

function syncSettingsForm(): void {
  const s = loadAiSettings();
  providerSel.value = s.provider;
  apiKeyInput.value = s.apiKey;
  modelInput.value = s.model;
  baseUrlInput.value = s.baseUrl;
  updateSettingsVisibility();
}
function updateSettingsVisibility(): void {
  const p = providerSel.value as AiProvider;
  $('row-apikey').hidden = p === 'local' || p === 'ollama';
  $('row-model').hidden = p === 'local';
  $('row-baseurl').hidden = p === 'local' || p === 'groq' || p === 'openrouter';
  const d = PROVIDER_DEFAULTS[p];
  modelInput.placeholder = d.model || 'имя модели';
  baseUrlInput.placeholder = d.baseUrl || 'https://…';
}
providerSel.addEventListener('change', updateSettingsVisibility);
$('ai-settings-save').addEventListener('click', () => {
  const s: AiSettings = {
    provider: providerSel.value as AiProvider,
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
  };
  localStorage.setItem('noir-ai-settings', JSON.stringify(s));
  addMsg('info', '⚙️ Настройки ИИ сохранены.');
  $('ai-settings').hidden = true;
});
$('ai-settings-btn').addEventListener('click', () => {
  const panel = $('ai-settings');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) syncSettingsForm();
});

function setSidebar(open: boolean): void {
  sidebarOpen = open;
  aiSidebar.hidden = !open;
  document.body.classList.toggle('sidebar-open', open);
  btnAi.classList.toggle('open', open);
  void noir.setSidebarOpen(open);
  if (open) aiInput.focus();
}
btnAi.addEventListener('click', () => setSidebar(!sidebarOpen));
$('ai-close-btn').addEventListener('click', () => setSidebar(false));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyA') {
    e.preventDefault();
    setSidebar(!sidebarOpen);
  }
});

function addMsg(kind: 'user' | 'step' | 'done' | 'error' | 'info', text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.textContent = text;
  aiMessages.append(el);
  aiMessages.scrollTop = aiMessages.scrollHeight;
  return el;
}

addMsg(
  'info',
  'Привет! Я встроенный агент Noir — управляю браузером по вашим словам. Работаю бесплатно и офлайн.\n\nУмею: «открой vk.com», «найди рецепт борща», «кликни Войти», «введи в поиск кошки», «прокрути вниз», «что на этой странице?», «закрой вкладку». Для сложных задач подключите бесплатную LLM в настройках ⚙️ (Groq / Ollama).',
);

let thinkingEl: HTMLElement | null = null;
function setAiBusy(busy: boolean): void {
  aiBusy = busy;
  aiSend.disabled = busy;
  aiInput.disabled = busy;
  aiCancel.hidden = !busy;
  if (busy) {
    thinkingEl = addMsg('step', '🤔 Думаю');
    thinkingEl.classList.add('thinking');
  } else {
    thinkingEl?.remove();
    thinkingEl = null;
  }
}

noir.onAiEvent((event) => {
  if (event.kind === 'step' && thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
  addMsg(event.kind, event.text);
  if (event.kind === 'done' || event.kind === 'error') setAiBusy(false);
});

function runCommand(text: string): void {
  const command = text.trim();
  if (!command || aiBusy) return;
  addMsg('user', command);
  setAiBusy(true);
  void noir.runAiCommand(command, loadAiSettings()).catch((err: unknown) => {
    addMsg('error', '⚠️ Не удалось выполнить команду: ' + String(err));
    setAiBusy(false);
  });
}

$<HTMLFormElement>('ai-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runCommand(aiInput.value);
  aiInput.value = '';
});
aiCancel.addEventListener('click', () => void noir.cancelAi());
for (const chip of document.querySelectorAll<HTMLButtonElement>('.chip')) {
  chip.addEventListener('click', () => runCommand(chip.textContent ?? ''));
}
