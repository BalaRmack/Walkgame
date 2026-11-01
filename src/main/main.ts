/**
 * Noir Browser — main-процесс.
 * Отвечает за: frameless-окно, вкладки (WebContentsView), навигацию,
 * контекстное меню. Блокировщик и ИИ-агент живут в отдельных модулях
 * (adblocker.ts, agent.ts) и подключаются отсюда.
 */
import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, WebContentsView, Menu, session, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { TabInfo, TabsState } from '../shared/protocol';

// Тёмная тема — по умолчанию и навсегда (требование дизайна).
nativeTheme.themeSource = 'dark';

export const NEWTAB_URL = 'noir://newtab';
const HOME_URL = NEWTAB_URL;
const SEARCH_URL = 'https://duckduckgo.com/?q=';

/** Высоты хром-области окна: полоса вкладок + тулбар. Синхронизировано со styles.css */
const CHROME_HEIGHT = 96;
const SIDEBAR_WIDTH = 372;

interface TabRecord {
  id: number;
  view: WebContentsView | null; // null => внутренняя страница новой вкладки
  title: string;
  url: string;
  favicon: string;
  loading: boolean;
}

let win: BrowserWindow | null = null;
let nextTabId = 1;
const tabs = new Map<number, TabRecord>();
let activeTabId = -1;
let sidebarOpen = false;

/** Нормализует ввод адресной строки: URL как есть, остальное — в поиск DuckDuckGo. */
export function normalizeInput(raw: string): string {
  const input = raw.trim();
  if (!input) return NEWTAB_URL;
  if (input === NEWTAB_URL || input === 'noir://home') return NEWTAB_URL;
  if (/^(https?|file):\/\//i.test(input)) return input;
  // "g запрос" — быстрый поиск в Google, "yt запрос" — на YouTube
  const g = input.match(/^g\s+(.+)/i);
  if (g) return 'https://www.google.com/search?q=' + encodeURIComponent(g[1]);
  const yt = input.match(/^yt\s+(.+)/i);
  if (yt) return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(yt[1]);
  // Похоже на домен: example.com, sub.example.ru/path, localhost:3000
  if (/^[^\s]+\.[a-z]{2,}([/?#].*)?$/i.test(input) || /^localhost(:\d+)?(\/.*)?$/.test(input)) {
    return 'https://' + input;
  }
  return SEARCH_URL + encodeURIComponent(input);
}

export function getWindow(): BrowserWindow | null {
  return win;
}

export function getActiveTab(): TabRecord | undefined {
  return tabs.get(activeTabId);
}

function navFlags(tab: TabRecord): { canGoBack: boolean; canGoForward: boolean } {
  const wc = tab.view?.webContents;
  if (!wc) return { canGoBack: false, canGoForward: false };
  try {
    return {
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
}

function broadcastTabs(): void {
  if (!win) return;
  const list: TabInfo[] = [...tabs.values()].map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    favicon: t.favicon,
    loading: t.loading,
    isNewTab: t.view === null,
    ...navFlags(t),
  }));
  const state: TabsState = { tabs: list, activeId: activeTabId };
  win.webContents.send('tabs:state', state);
}

/** Раскладывает WebContentsView активной вкладки под хром-областью окна. */
function layoutActiveView(): void {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const contentWidth = Math.max(0, width - (sidebarOpen ? SIDEBAR_WIDTH : 0));
  for (const tab of tabs.values()) {
    if (!tab.view) continue;
    const visible = tab.id === activeTabId;
    tab.view.setVisible(visible);
    if (visible) {
      tab.view.setBounds({
        x: 0,
        y: CHROME_HEIGHT,
        width: contentWidth,
        height: Math.max(0, height - CHROME_HEIGHT),
      });
    }
  }
}

export function createTab(rawUrl?: string, activate = true): TabRecord {
  const url = rawUrl ? normalizeInput(rawUrl) : NEWTAB_URL;
  const id = nextTabId++;
  const tab: TabRecord = {
    id,
    view: null,
    title: 'Новая вкладка',
    url,
    favicon: '',
    loading: false,
  };
  tabs.set(id, tab);
  if (url !== NEWTAB_URL) {
    ensureView(tab);
    void tab.view!.webContents.loadURL(url).catch(() => undefined);
  }
  if (activate || activeTabId === -1) activeTabId = id;
  layoutActiveView();
  broadcastTabs();
  if (activate && url === NEWTAB_URL) win?.webContents.send('ui:focus-omnibox');
  return tab;
}

/** Создаёт WebContentsView для вкладки (при первом реальном переходе со стартовой страницы). */
function ensureView(tab: TabRecord): WebContentsView {
  if (tab.view) return tab.view;
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  view.setBackgroundColor('#111111');
  tab.view = view;
  win?.contentView.addChildView(view);

  const wc = view.webContents;
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title || tab.title;
    broadcastTabs();
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = favicons[0] ?? '';
    broadcastTabs();
  });
  wc.on('did-start-loading', () => {
    tab.loading = true;
    broadcastTabs();
  });
  wc.on('did-stop-loading', () => {
    tab.loading = false;
    const url = wc.getURL();
    if (!url.startsWith('data:')) tab.url = url; // data: — наша служебная страница ошибки
    broadcastTabs();
  });
  wc.on('did-navigate', (_e, url) => {
    if (!url.startsWith('data:')) tab.url = url;
    broadcastTabs();
  });
  wc.on('did-navigate-in-page', (_e, url) => {
    if (!url.startsWith('data:')) tab.url = url;
    broadcastTabs();
  });
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = прервано пользователем/редиректом
    tab.loading = false;
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
      'body{background:#111;color:#eee;font-family:Segoe UI,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
      '.box{max-width:520px;text-align:center}h1{font-size:22px}p{color:#999;line-height:1.5}' +
      '</style></head><body><div class="box"><h1>🌑 Не удалось открыть страницу</h1><p>' +
      escapeHtml(errorDescription) + '<br>' + escapeHtml(validatedURL) +
      '</p><p>Проверьте адрес и соединение, затем нажмите «Обновить».</p></div></body></html>';
    void wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => undefined);
    broadcastTabs();
  });

  // Ссылки, требующие новое окно, открываем новой вкладкой (как Chrome).
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) createTab(url);
    return { action: 'deny' };
  });
  // Внешние протоколы (mailto:, tg: и т.п.) — в системные приложения.
  wc.on('will-navigate', (e, url) => {
    if (!/^(https?|data|about|blob|file):/i.test(url)) {
      e.preventDefault();
      void shell.openExternal(url).catch(() => undefined);
    }
  });

  attachContextMenu(tab);
  attachShortcuts(wc);
  return view;
}

/** Браузерные горячие клавиши, работающие и когда фокус на веб-странице. */
function attachShortcuts(wc: Electron.WebContents): void {
  wc.on('before-input-event', (event, input) => {
    const mod = input.control || input.meta;
    if (!mod || input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 't') { event.preventDefault(); createTab(); }
    else if (key === 'w') { event.preventDefault(); closeTab(activeTabId); }
    else if (key === 'l') { event.preventDefault(); win?.webContents.focus(); win?.webContents.send('ui:focus-omnibox'); }
    else if (key === 'r' && !input.shift) { /* Ctrl+R оставляем странице только если это не наш фокус — перезагружаем сами */ event.preventDefault(); wc.reload(); }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Минимальное контекстное меню страницы. */
function attachContextMenu(tab: TabRecord): void {
  const wc = tab.view!.webContents;
  wc.on('context-menu', (_e, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    const flags = navFlags(tab);
    template.push(
      { label: 'Назад', enabled: flags.canGoBack, click: () => wc.navigationHistory.goBack() },
      { label: 'Вперёд', enabled: flags.canGoForward, click: () => wc.navigationHistory.goForward() },
      { label: 'Обновить', click: () => wc.reload() },
      { type: 'separator' },
    );
    if (params.linkURL) {
      template.push(
        { label: 'Открыть ссылку в новой вкладке', click: () => createTab(params.linkURL) },
        { label: 'Копировать адрес ссылки', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      template.push(
        { label: 'Вырезать', role: 'cut', enabled: params.selectionText.length > 0 },
        { label: 'Копировать', role: 'copy', enabled: params.selectionText.length > 0 },
        { label: 'Вставить', role: 'paste' },
        { label: 'Выделить всё', role: 'selectAll' },
      );
    } else if (params.selectionText) {
      template.push(
        { label: 'Копировать', role: 'copy' },
        {
          label: `Найти «${params.selectionText.slice(0, 24)}…»`,
          click: () => createTab(params.selectionText),
        },
      );
    }
    template.push(
      { type: 'separator' },
      { label: 'Новая вкладка', click: () => createTab() },
      { label: 'Просмотреть код', click: () => wc.inspectElement(params.x, params.y) },
    );
    Menu.buildFromTemplate(template).popup();
  });
}

function closeTab(id: number): void {
  const tab = tabs.get(id);
  if (!tab) return;
  const order = [...tabs.keys()];
  const idx = order.indexOf(id);
  if (tab.view) {
    win?.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  }
  tabs.delete(id);
  if (tabs.size === 0) {
    createTab();
    return;
  }
  if (activeTabId === id) {
    const remaining = [...tabs.keys()];
    activeTabId = remaining[Math.min(idx, remaining.length - 1)];
  }
  layoutActiveView();
  broadcastTabs();
}

/** Закрыть активную вкладку (используется ИИ-агентом). */
export function closeActiveTab(): void {
  if (activeTabId !== -1) closeTab(activeTabId);
}

export function navigateActive(raw: string): void {
  const tab = getActiveTab();
  if (!tab) return;
  const url = normalizeInput(raw);
  if (url === NEWTAB_URL) {
    if (tab.view) {
      win?.contentView.removeChildView(tab.view);
      tab.view.webContents.close();
      tab.view = null;
    }
    tab.url = NEWTAB_URL;
    tab.title = 'Новая вкладка';
    tab.favicon = '';
    tab.loading = false;
    layoutActiveView();
    broadcastTabs();
    win?.webContents.send('ui:focus-omnibox');
    return;
  }
  const view = ensureView(tab);
  tab.url = url;
  layoutActiveView();
  broadcastTabs();
  void view.webContents.loadURL(url).catch(() => undefined);
}

function registerIpc(): void {
  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.on('window:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', () => win?.close());

  ipcMain.handle('tabs:create', (_e, url?: string) => {
    createTab(url);
  });
  ipcMain.handle('tabs:close', (_e, id: number) => closeTab(id));
  ipcMain.handle('tabs:activate', (_e, id: number) => {
    if (tabs.has(id)) {
      activeTabId = id;
      layoutActiveView();
      broadcastTabs();
      const t = getActiveTab();
      if (t?.view) t.view.webContents.focus();
    }
  });
  ipcMain.handle('nav:go', (_e, input: string) => navigateActive(input));
  ipcMain.handle('nav:back', () => getActiveTab()?.view?.webContents.navigationHistory.goBack());
  ipcMain.handle('nav:forward', () => getActiveTab()?.view?.webContents.navigationHistory.goForward());
  ipcMain.handle('nav:reload', () => {
    const wc = getActiveTab()?.view?.webContents;
    if (wc) wc.isLoading() ? wc.stop() : wc.reload();
  });
  ipcMain.handle('nav:stop', () => getActiveTab()?.view?.webContents.stop());
  ipcMain.handle('nav:home', () => navigateActive(HOME_URL));
  ipcMain.handle('layout:sidebar', (_e, open: boolean) => {
    sidebarOpen = open;
    layoutActiveView();
  });
}

function createWindow(): void {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: '#0f0f0f',
    title: 'Noir Browser',
    // В упакованном приложении иконка окна берётся из .exe; файл нужен только в dev-режиме.
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.on('resize', layoutActiveView);
  win.on('maximize', layoutActiveView);
  win.on('unmaximize', layoutActiveView);
  win.on('closed', () => {
    win = null;
  });

  // Горячие клавиши браузера (на уровне UI-оболочки).
  win.webContents.on('before-input-event', (_e, input) => {
    const mod = input.control || input.meta;
    if (!mod || input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 't') createTab();
    else if (key === 'w') closeTab(activeTabId);
    else if (key === 'l') win?.webContents.send('ui:focus-omnibox');
    else if (key === 'r') getActiveTab()?.view?.webContents.reload();
  });

  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    createTab();
  });
}

/** Загрузки — молча в папку «Загрузки», разрешения сайтам не выдаём (приватность по умолчанию). */
function setupSessionPolicies(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads');
    let target = path.join(dir, item.getFilename());
    let n = 1;
    while (fs.existsSync(target)) {
      const ext = path.extname(item.getFilename());
      const base = path.basename(item.getFilename(), ext);
      target = path.join(dir, `${base} (${n++})${ext}`);
    }
    item.setSavePath(target);
    item.once('done', (_ev, state) => console.log(`[noir-download] ${state}: ${target}`));
  });
}

/**
 * Smoke-тест для CI: `Noir Browser.exe --smoke-test`
 * Запускает браузер, командой агента открывает example.com, проверяет
 * блокировщик и пишет noir-smoke-result.json. Используется в GitHub Actions,
 * чтобы релизный .exe был не просто собран, а реально проверен запуском.
 */
async function runSmokeTest(): Promise<void> {
  const steps: string[] = [];
  const result: Record<string, unknown> = { startedAt: new Date().toISOString(), steps };
  const log = (s: string) => { steps.push(s); console.log('[smoke]', s); };
  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    result.finishedAt = new Date().toISOString();
    try { fs.writeFileSync(path.join(process.cwd(), 'noir-smoke-result.json'), JSON.stringify(result, null, 2)); } catch { /* ignore */ }
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'noir-smoke-result.json'), JSON.stringify(result, null, 2)); } catch { /* ignore */ }
    console.log(code === 0 ? 'SMOKE OK' : `SMOKE FAIL (${code})`);
    app.exit(code);
  };
  setTimeout(() => { log('WATCHDOG TIMEOUT'); finish(3); }, 150_000);

  try {
    await new Promise((r) => setTimeout(r, 2_500));
    log(`window created: ${!!win}, tabs: ${tabs.size}`);

    const { smokeRunLocalCommand } = require('./agent') as typeof import('./agent');
    const ok = await smokeRunLocalCommand('открой example.com', (line) => log('agent: ' + line));
    // Ждём реальной загрузки: заголовок example.com — «Example Domain».
    let tab = getActiveTab();
    for (let i = 0; i < 25 && !(tab?.title ?? '').includes('Example'); i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      tab = getActiveTab();
    }
    log(`agent open handled=${ok} url=${tab?.url} title=${tab?.title}`);
    result.agentOpen = ok && (tab?.url.includes('example.com') ?? false) && (tab?.title.includes('Example') ?? false);

    const { getAdblockStatus } = require('./adblocker') as typeof import('./adblocker');
    for (let i = 0; i < 40 && !getAdblockStatus().ready; i++) await new Promise((r) => setTimeout(r, 1_000));
    result.adblock = getAdblockStatus();
    log(`adblock: ${JSON.stringify(result.adblock)}`);

    const adblock = result.adblock as { ready: boolean; enabled: boolean };
    // Строгий критерий: окно есть, агент открыл сайт, блокировщик реально загрузился.
    finish(win && tab && result.agentOpen && adblock.ready && adblock.enabled ? 0 : 1);
  } catch (err) {
    log('ERROR ' + String(err));
    finish(2);
  }
}

app.whenReady().then(() => {
  registerIpc();
  setupSessionPolicies();
  createWindow();
  // Подключаем блокировщик рекламы и ИИ-агента (модули регистрируют свой IPC сами).
  const { initAdblocker } = require('./adblocker') as typeof import('./adblocker');
  const { initAgent } = require('./agent') as typeof import('./agent');
  initAdblocker(getWindow);
  initAgent({ getWindow, getActiveTab, createTab, navigateActive, closeActiveTab });

  if (process.argv.includes('--smoke-test')) void runSmokeTest();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
