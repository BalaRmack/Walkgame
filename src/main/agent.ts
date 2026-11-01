/** Заглушка: ИИ-агент — следующим коммитом. */
import type { BrowserWindow } from 'electron';

export interface AgentDeps {
  getWindow: () => BrowserWindow | null;
  getActiveTab: () => unknown;
  createTab: (url?: string) => unknown;
  navigateActive: (raw: string) => void;
}

export function initAgent(_deps: AgentDeps): void {
  // TODO(feat/ai-agent)
}
