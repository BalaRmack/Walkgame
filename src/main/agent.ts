/**
 * Встроенный бесплатный ИИ-агент Noir.
 *
 * Два уровня интеллекта:
 *  1) Локальный интерпретатор команд (по умолчанию) — понимает естественные
 *     фразы на русском и английском без API-ключей, сети и внешних сервисов:
 *     открыть сайт, найти, кликнуть по тексту, ввести текст, заполнить поле,
 *     прокрутить, прочитать страницу, управлять вкладками.
 *  2) LLM-планировщик (опционально) — если в настройках указан бесплатный
 *     провайдер (Groq free tier, OpenRouter free-модели, локальная Ollama или
 *     любой OpenAI-совместимый endpoint), модель получает снимок страницы и
 *     возвращает JSON-план действий, который агент исполняет теми же
 *     примитивами (navigate/click/type/scroll/extract) — по сути, тот же
 *     подход, что и в browser-use, но нативно на Electron/TS без Python-рантайма
 *     внутри Windows-установщика.
 */
import { ipcMain } from 'electron';
import type { BrowserWindow, WebContents, WebContentsView } from 'electron';
import type { AiEvent, AiSettings } from '../shared/protocol';
import { normalizeInput, NEWTAB_URL } from './main';

export interface AgentTab {
  view: WebContentsView | null;
  url: string;
  title: string;
}

export interface AgentDeps {
  getWindow: () => BrowserWindow | null;
  getActiveTab: () => AgentTab | undefined;
  createTab: (url?: string) => unknown;
  navigateActive: (raw: string) => void;
  closeActiveTab: () => void;
}

type Emit = (kind: AiEvent['kind'], text: string) => void;

let deps: AgentDeps;
let running = false;
let cancelled = false;

/** Популярные сайты по-человечески: «открой ютуб» -> youtube.com */
const ALIASES: Record<string, string> = {
  'ютуб': 'https://www.youtube.com', 'youtube': 'https://www.youtube.com',
  'вк': 'https://vk.com', 'vk': 'https://vk.com', 'вконтакте': 'https://vk.com',
  'телеграм': 'https://web.telegram.org', 'telegram': 'https://web.telegram.org',
  'гугл': 'https://www.google.com', 'google': 'https://www.google.com',
  'гитхаб': 'https://github.com', 'github': 'https://github.com',
  'википедию': 'https://ru.wikipedia.org', 'википедия': 'https://ru.wikipedia.org', 'wikipedia': 'https://ru.wikipedia.org',
  'яндекс': 'https://ya.ru', 'дзен': 'https://dzen.ru',
  'хабр': 'https://habr.com', 'habr': 'https://habr.com',
  'твич': 'https://www.twitch.tv', 'twitch': 'https://www.twitch.tv',
  'почту': 'https://mail.google.com', 'gmail': 'https://mail.google.com',
  'карты': 'https://www.google.com/maps',
  'новости': 'https://dzen.ru/news',
};

function activeWebContents(): WebContents | null {
  return deps.getActiveTab()?.view?.webContents ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function checkCancelled(): void {
  if (cancelled) throw new Error('__cancelled__');
}

async function waitForLoad(wc: WebContents, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (wc.isLoading()) {
    checkCancelled();
    if (Date.now() - started > timeoutMs) return;
    await sleep(180);
  }
  await sleep(250); // дать странице дорисоваться
}

/** Открыть адрес: на стартовой вкладке — прямо в ней, иначе новой вкладкой (как ждут от агента). */
async function openSmart(rawInput: string, emit: Emit): Promise<void> {
  const tab = deps.getActiveTab();
  const onStartPage = !tab || tab.view === null || tab.url === NEWTAB_URL;
  if (onStartPage) deps.navigateActive(rawInput);
  else deps.createTab(rawInput);
  const wc = activeWebContents();
  if (wc) await waitForLoad(wc);
  const now = deps.getActiveTab();
  emit('step', `🌐 Открыто: ${now?.title || now?.url || rawInput}`);
}

/** Выполнить JS на активной странице; вернуть понятную ошибку, если сайта нет. */
async function pageJS<T>(code: string): Promise<T> {
  const wc = activeWebContents();
  if (!wc) throw new Error('Сейчас открыта стартовая страница. Сначала откройте сайт — например: «открой youtube.com».');
  return (await wc.executeJavaScript(code, true)) as T;
}

// ---------------- Примитивы управления страницей ----------------

async function clickByText(text: string, emit: Emit): Promise<boolean> {
  const found = await pageJS<string | null>(`(() => {
    const needle = ${JSON.stringify(text)}.trim().toLowerCase();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim();
    const candidates = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"], [onclick]')].filter(visible);
    let el = candidates.find(e => label(e).toLowerCase() === needle)
        || candidates.find(e => label(e).toLowerCase().includes(needle));
    if (!el) {
      // Запасной вариант: любой листовой элемент с таким текстом.
      el = [...document.querySelectorAll('span, div, li, td, label')]
        .filter(e => visible(e) && e.children.length === 0 && label(e).toLowerCase().includes(needle))[0];
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return label(el).slice(0, 80) || needle;
  })()`);
  if (found) {
    emit('step', `🖱️ Нажал: «${found}»`);
    const wc = activeWebContents();
    if (wc) await waitForLoad(wc, 8_000);
    return true;
  }
  emit('step', `🔎 Не нашёл на странице элемент с текстом «${text}». Попробуйте точнее или прокрутите страницу.`);
  return false;
}

async function typeText(opts: { text: string; field?: string; submit?: boolean }, emit: Emit): Promise<boolean> {
  const ok = await pageJS<boolean>(`(() => {
    const text = ${JSON.stringify(opts.text)};
    const field = ${JSON.stringify(opts.field ?? '')}.toLowerCase();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled && !el.readOnly;
    };
    const inputs = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
      .filter(el => visible(el) && !['checkbox','radio','file','hidden','submit','button'].includes((el.type || '').toLowerCase()));
    if (!inputs.length) return false;
    let target = null;
    if (field) {
      target = inputs.find(el => {
        const id = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        const descr = [el.placeholder, el.name, el.getAttribute('aria-label'), id ? id.innerText : ''].join(' ').toLowerCase();
        return descr.includes(field);
      });
    }
    if (!target) {
      target = inputs.find(el => (el.type || '').toLowerCase() === 'search'
        || /^(q|query|search|keyword|s)$/i.test(el.name || '')
        || /search|поиск/i.test((el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')))
        || inputs[0];
    }
    target.focus();
    if (target.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } else {
      const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(target, text);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (${JSON.stringify(!!opts.submit)}) {
      const form = target.closest('form');
      if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
      else {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      }
    }
    return true;
  })()`);
  if (ok) {
    emit('step', opts.submit ? `⌨️ Ввёл «${opts.text}» и отправил.` : `⌨️ Ввёл «${opts.text}».`);
    if (opts.submit) {
      const wc = activeWebContents();
      if (wc) await waitForLoad(wc, 10_000);
    }
    return true;
  }
  emit('step', '🔎 Не нашёл поле ввода на этой странице.');
  return false;
}

async function scrollPage(direction: 'down' | 'up' | 'top' | 'bottom', emit: Emit): Promise<void> {
  const expr =
    direction === 'down' ? 'window.scrollBy({ top: innerHeight * 0.85, behavior: "smooth" })'
    : direction === 'up' ? 'window.scrollBy({ top: -innerHeight * 0.85, behavior: "smooth" })'
    : direction === 'top' ? 'window.scrollTo({ top: 0, behavior: "smooth" })'
    : 'window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })';
  await pageJS(`(() => { ${expr}; return true; })()`);
  emit('step', direction === 'down' ? '⬇️ Прокрутил вниз.' : direction === 'up' ? '⬆️ Прокрутил вверх.' : direction === 'top' ? '⏫ В самое начало.' : '⏬ В самый конец страницы.');
  await sleep(450);
}

interface PageSnapshot {
  title: string;
  url: string;
  headings: string[];
  text: string;
  elements: string;
}

async function snapshot(): Promise<PageSnapshot> {
  return pageJS<PageSnapshot>(`(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const headings = [...document.querySelectorAll('h1, h2')].slice(0, 12).map(h => clean(h.innerText)).filter(Boolean);
    const root = document.querySelector('main, article') || document.body;
    const text = clean(root ? root.innerText : '').slice(0, 5000);
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const els = [...document.querySelectorAll('a, button, [role="button"], input, textarea')]
      .filter(visible).slice(0, 60)
      .map(el => {
        const t = clean(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 50);
        return t ? el.tagName.toLowerCase() + ': "' + t + '"' : '';
      }).filter(Boolean).join('\\n');
    return { title: document.title, url: location.href, headings, text, elements: els };
  })()`);
}

function localSummary(snap: PageSnapshot): string {
  const parts = [`📄 Страница: «${snap.title}»`, snap.url];
  if (snap.headings.length) parts.push('\nЗаголовки:\n• ' + snap.headings.slice(0, 8).join('\n• '));
  const excerpt = snap.text.slice(0, 900);
  if (excerpt) parts.push('\nНачало содержания:\n' + excerpt + (snap.text.length > 900 ? '…' : ''));
  return parts.join('\n');
}

// ---------------- Локальный интерпретатор команд ----------------

async function runLocalRules(command: string, emit: Emit): Promise<boolean> {
  const raw = command.trim();
  const cmd = raw.toLowerCase();

  const done = async (fn: () => Promise<unknown> | unknown): Promise<true> => {
    await fn();
    return true;
  };

  // Вкладки и навигация
  if (/^(новая вкладка|открой новую вкладку|создай вкладку|new tab)/.test(cmd))
    return done(() => { deps.createTab(); emit('step', '🗂️ Открыл новую вкладку.'); });
  if (/^(закрой|убери) (эту )?(вкладку|таб)|^close tab/.test(cmd))
    return done(() => { deps.closeActiveTab(); emit('step', '🗂️ Вкладка закрыта.'); });
  if (cmd === 'назад' || cmd === 'back' || cmd === 'вернись назад')
    return done(() => activeWebContents()?.navigationHistory.goBack());
  if (cmd === 'вперёд' || cmd === 'вперед' || cmd === 'forward')
    return done(() => activeWebContents()?.navigationHistory.goForward());
  if (/^(обнови|перезагрузи|reload|refresh)/.test(cmd))
    return done(async () => { const wc = activeWebContents(); wc?.reload(); if (wc) await waitForLoad(wc); emit('step', '🔄 Страница обновлена.'); });
  if (/^(домой|на главную|home)/.test(cmd))
    return done(() => { deps.navigateActive(NEWTAB_URL); emit('step', '🏠 Стартовая страница Noir.'); });
  if (/^(что ты умеешь|помощь|помоги|help|команды)/.test(cmd))
    return done(() => emit('step',
      'Умею вот что:\n• «открой youtube.com» / «открой ютуб»\n• «найди погоду в Москве» / «найди на ютубе кошек»\n• «кликни Войти» / «нажми Подписаться»\n• «введи в поиск новости» (и отправлю поиск)\n• «заполни поле Email значением test@mail.ru»\n• «прокрути вниз/вверх/в конец»\n• «что на этой странице?»\n• «новая вкладка», «закрой вкладку», «назад», «обнови», «домой»'));

  // Прокрутка
  if (/прокрут|scroll|листай/.test(cmd)) {
    if (/вверх|наверх|up/.test(cmd)) return done(() => scrollPage('up', emit));
    if (/начал|самый верх|top/.test(cmd)) return done(() => scrollPage('top', emit));
    if (/конец|низ до конца|bottom/.test(cmd)) return done(() => scrollPage('bottom', emit));
    return done(() => scrollPage('down', emit));
  }

  // Чтение страницы
  if (/(что|о чём|о чем|прочитай|расскажи|опиши|summar|read).*(страниц|сайт|здесь|тут)|^(что (на|это))/.test(cmd) || cmd.includes('что на этой странице')) {
    return done(async () => emit('step', localSummary(await snapshot())));
  }

  // Заполнение конкретного поля
  const fillMatch = raw.match(/(?:заполни|введи|укажи)(?:\s+в)?(?:\s+поле)?\s+[«"]?([^«»":]+?)[»"]?\s*(?::|=|значением|—|-)\s*(.+)$/i);
  if (fillMatch && /(поле|заполни)/i.test(cmd)) {
    const [, field, value] = fillMatch;
    return done(() => typeText({ text: value.trim(), field: field.trim(), submit: false }, emit));
  }

  // Ввод текста (в поиск — с отправкой)
  const typeMatch = raw.match(/^(?:введи|печатай|напиши|вбей|type|write)(?:\s+в поиск(?:е|овую строку)?)?\s*[:«]?\s*(.+?)[»]?$/i);
  if (typeMatch) {
    const text = typeMatch[1].trim();
    const isSearch = /поиск/.test(cmd);
    return done(() => typeText({ text, submit: isSearch }, emit));
  }

  // Клик по тексту
  const clickMatch = raw.match(/^(?:кликни|нажми|щ[её]лкни|тапни|click|press)(?:\s+на)?(?:\s+(?:кнопку|ссылку|элемент))?\s*[:«]?\s*(.+?)[»]?$/i);
  if (clickMatch) {
    return done(() => clickByText(clickMatch[1].trim(), emit));
  }

  // Поиск
  const searchMatch = raw.match(/^(?:найди|поиск|искать|найди мне|загугли|гугл|search|google|find)\s+(.+)$/i)
    ?? raw.match(/^(?:погода|новости|курс|рецепт|как|сколько|когда|кто|что такое|где)\b.*$/i);
  if (searchMatch) {
    const query = (searchMatch[1] ?? searchMatch[0]).trim();
    return done(async () => {
      const yt = query.match(/^на (?:ютубе|youtube)\s+(.+)$/i);
      if (yt) {
        emit('step', `🔍 Ищу на YouTube: ${yt[1]}`);
        await openSmart('yt ' + yt[1], emit);
      } else {
        emit('step', `🔍 Ищу: ${query}`);
        await openSmart(query, emit);
      }
    });
  }

  // Открыть сайт
  const openMatch = raw.match(/^(?:открой|перейди|зайди|открывай|open|go to|visit)\s+(?:на\s+)?(?:сайт\s+)?(.+)$/i);
  if (openMatch) {
    const target = openMatch[1].trim().replace(/[.!]+$/, '');
    const alias = ALIASES[target.toLowerCase()];
    return done(async () => {
      emit('step', alias ? `🌐 Открываю ${target}…` : `🌐 Открываю ${normalizeInput(target)}`);
      await openSmart(alias ?? target, emit);
    });
  }

  // «Сухой» адрес без глагола: example.com
  if (/^[^\s]+\.[a-z]{2,}([/?#].*)?$/i.test(raw) || ALIASES[cmd]) {
    return done(() => openSmart(ALIASES[cmd] ?? raw, emit));
  }

  return false;
}

// ---------------- LLM-планировщик (опционально, бесплатные tier) ----------------

interface LlmConfig { url: string; apiKey: string; model: string; }

function llmConfig(settings: AiSettings): LlmConfig | null {
  const model = settings.model.trim();
  switch (settings.provider) {
    case 'groq':
      if (!settings.apiKey.trim()) return null;
      return { url: 'https://api.groq.com/openai/v1/chat/completions', apiKey: settings.apiKey.trim(), model: model || 'llama-3.3-70b-versatile' };
    case 'openrouter':
      if (!settings.apiKey.trim()) return null;
      return { url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: settings.apiKey.trim(), model: model || 'meta-llama/llama-3.3-70b-instruct:free' };
    case 'ollama': {
      let base = (settings.baseUrl.trim() || 'http://localhost:11434').replace(/\/$/, '');
      if (!base.endsWith('/v1')) base += '/v1';
      return { url: base + '/chat/completions', apiKey: '', model: model || 'llama3.1' };
    }
    case 'custom': {
      const base = settings.baseUrl.trim().replace(/\/$/, '');
      if (!base) return null;
      return { url: base + '/chat/completions', apiKey: settings.apiKey.trim(), model: model || 'gpt-4o-mini' };
    }
    default:
      return null;
  }
}

async function chat(cfg: LlmConfig, messages: Array<{ role: string; content: string }>): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.1 }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

interface AgentAction {
  type: string;
  url?: string;
  query?: string;
  text?: string;
  field?: string;
  submit?: boolean;
  direction?: 'down' | 'up' | 'top' | 'bottom';
  seconds?: number;
}

async function execAction(action: AgentAction, emit: Emit, cfg: LlmConfig | null, originalCommand: string): Promise<void> {
  checkCancelled();
  switch (action.type) {
    case 'open':
      if (action.url) await openSmart(action.url, emit);
      break;
    case 'search':
      if (action.query) { emit('step', `🔍 Ищу: ${action.query}`); await openSmart(action.query, emit); }
      break;
    case 'click':
      if (action.text) await clickByText(action.text, emit);
      break;
    case 'type':
      if (action.text) await typeText({ text: action.text, field: action.field, submit: action.submit }, emit);
      break;
    case 'scroll':
      await scrollPage(action.direction ?? 'down', emit);
      break;
    case 'back': activeWebContents()?.navigationHistory.goBack(); break;
    case 'forward': activeWebContents()?.navigationHistory.goForward(); break;
    case 'reload': { const wc = activeWebContents(); wc?.reload(); if (wc) await waitForLoad(wc); break; }
    case 'newtab': deps.createTab(action.url); break;
    case 'closetab': deps.closeActiveTab(); break;
    case 'home': deps.navigateActive(NEWTAB_URL); break;
    case 'wait': await sleep(Math.min(10, Math.max(0, action.seconds ?? 1)) * 1000); break;
    case 'read': {
      const snap = await snapshot();
      if (cfg) {
        const answer = await chat(cfg, [
          { role: 'system', content: 'Отвечай кратко, по-русски, только по содержанию страницы.' },
          { role: 'user', content: `Запрос пользователя: ${originalCommand}\n\nСтраница «${snap.title}» (${snap.url}):\n${snap.text}` },
        ]);
        emit('step', '📄 ' + answer.trim());
      } else {
        emit('step', localSummary(snap));
      }
      break;
    }
    default:
      emit('step', `⚠️ Неизвестное действие от модели: ${action.type}`);
  }
}

async function runLlmPlanner(command: string, settings: AiSettings, emit: Emit): Promise<boolean> {
  const cfg = llmConfig(settings);
  if (!cfg) return false;
  emit('step', `🧠 Спрашиваю модель ${cfg.model}…`);

  let pageContext = 'Сейчас открыта стартовая страница.';
  const tab = deps.getActiveTab();
  if (tab?.view) {
    try {
      const snap = await snapshot();
      pageContext =
        `Текущая страница: «${snap.title}» — ${snap.url}\n` +
        `Заголовки: ${snap.headings.join('; ')}\nИнтерактивные элементы:\n${snap.elements}\n` +
        `Текст (фрагмент): ${snap.text.slice(0, 1200)}`;
    } catch { /* страница могла не дать снимок — не страшно */ }
  }

  const raw = await chat(cfg, [
    {
      role: 'system',
      content:
        'Ты — агент управления браузером. Отвечай ТОЛЬКО валидным JSON вида ' +
        '{"actions":[...],"say":"короткий комментарий пользователю по-русски"}. Без markdown и пояснений.\n' +
        'Доступные действия: ' +
        '{"type":"open","url":"https://…"}, {"type":"search","query":"…"}, ' +
        '{"type":"click","text":"точный текст элемента"}, ' +
        '{"type":"type","text":"…","field":"необязательная подсказка поля","submit":true|false}, ' +
        '{"type":"scroll","direction":"down|up|top|bottom"}, ' +
        '{"type":"back"},{"type":"forward"},{"type":"reload"},{"type":"newtab"},{"type":"closetab"},{"type":"home"}, ' +
        '{"type":"read"} (прочитать и ответить по содержанию), {"type":"wait","seconds":2}.\n' +
        'Не больше 6 действий. Для "click" используй текст из списка элементов страницы.',
    },
    { role: 'user', content: `Команда пользователя: ${command}\n\n${pageContext}` },
  ]);

  const jsonMatch = raw.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('модель вернула не JSON');
  const plan = JSON.parse(jsonMatch[0]) as { actions?: AgentAction[]; say?: string };
  if (plan.say) emit('step', '💬 ' + plan.say);
  const actions = Array.isArray(plan.actions) ? plan.actions.slice(0, 6) : [];
  if (!actions.length) throw new Error('модель не составила план действий');
  for (const action of actions) {
    checkCancelled();
    await execAction(action, emit, cfg, command);
  }
  return true;
}

/** Для CI smoke-теста: выполнить команду локальным интерпретатором и собрать лог шагов. */
export async function smokeRunLocalCommand(command: string, log: (s: string) => void): Promise<boolean> {
  cancelled = false;
  return runLocalRules(command, (_kind, text) => log(text));
}

// ---------------- Точка входа IPC ----------------

export function initAgent(agentDeps: AgentDeps): void {
  deps = agentDeps;

  ipcMain.handle('ai:cancel', () => {
    cancelled = true;
  });

  ipcMain.handle('ai:command', async (_e, command: string, settings: AiSettings) => {
    const win = deps.getWindow();
    const emit: Emit = (kind, text) => win?.webContents.send('ai:event', { kind, text } satisfies AiEvent);

    if (running) {
      emit('error', '⏳ Я ещё выполняю предыдущую команду. Нажмите «Стоп» или подождите.');
      return;
    }
    if (!command?.trim()) return;

    running = true;
    cancelled = false;
    try {
      let handled = false;

      // 1) Если настроена LLM — сначала она (умеет сложные многошаговые задачи).
      if (settings && settings.provider !== 'local') {
        try {
          handled = await runLlmPlanner(command, settings, emit);
        } catch (err) {
          if (cancelled) throw err;
          emit('info', `⚠️ LLM недоступна (${err instanceof Error ? err.message : String(err)}). Пробую встроенными командами…`);
        }
      }
      // 2) Локальный интерпретатор — бесплатный офлайн-запасной вариант.
      if (!handled) handled = await runLocalRules(command, emit);

      // 3) Совсем не поняли — честно трактуем как поиск.
      if (!handled) {
        emit('info', '🤔 Не распознал команду как действие — поищу это в интернете.');
        emit('step', `🔍 Ищу: ${command.trim()}`);
        await openSmart(command.trim(), emit);
      }

      const tab = deps.getActiveTab();
      emit('done', tab?.view ? `✅ Готово. Сейчас открыто: ${tab.title || tab.url}` : '✅ Готово.');
    } catch (err) {
      if (cancelled || (err instanceof Error && err.message === '__cancelled__')) {
        emit('error', '🛑 Остановлено.');
      } else {
        emit('error', `⚠️ Не смог выполнить: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      running = false;
      cancelled = false;
    }
  });
}
