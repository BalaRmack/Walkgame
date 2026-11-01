/**
 * Общий IPC-протокол Noir Browser.
 * Используется main-процессом, preload-скриптом и renderer'ом (через /// <reference>).
 */

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  favicon: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Внутренняя стартовая страница noir://newtab (рендерится самим UI, без WebContentsView) */
  isNewTab: boolean;
}

export interface TabsState {
  tabs: TabInfo[];
  activeId: number;
}

export interface AdblockStatus {
  /** Включён ли блокировщик пользователем */
  enabled: boolean;
  /** Движок загружен и реально фильтрует трафик */
  ready: boolean;
  /** Сколько запросов заблокировано за сессию */
  blockedTotal: number;
}

export type AiProvider = 'local' | 'ollama' | 'groq' | 'openrouter' | 'custom';

export interface AiSettings {
  provider: AiProvider;
  apiKey: string;
  model: string;
  /** Базовый URL для provider=custom и Ollama */
  baseUrl: string;
}

export interface AiEvent {
  kind: 'step' | 'done' | 'error' | 'info';
  text: string;
}

/** API, которое preload безопасно пробрасывает в renderer как window.noir */
export interface NoirApi {
  // Окно
  minimizeWindow(): void;
  maximizeWindow(): void;
  closeWindow(): void;
  // Вкладки и навигация
  createTab(url?: string): Promise<void>;
  closeTab(id: number): Promise<void>;
  activateTab(id: number): Promise<void>;
  navigate(input: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  goHome(): Promise<void>;
  stop(): Promise<void>;
  // Раскладка (боковая панель ИИ сдвигает веб-контент)
  setSidebarOpen(open: boolean): Promise<void>;
  // Блокировщик рекламы
  setAdblockEnabled(enabled: boolean): Promise<AdblockStatus>;
  getAdblockStatus(): Promise<AdblockStatus>;
  // ИИ-агент
  runAiCommand(command: string, settings: AiSettings): Promise<void>;
  cancelAi(): Promise<void>;
  // Подписки на события из main
  onTabsState(cb: (state: TabsState) => void): void;
  onAdblockStatus(cb: (status: AdblockStatus) => void): void;
  onAiEvent(cb: (event: AiEvent) => void): void;
  onFocusOmnibox(cb: () => void): void;
}
