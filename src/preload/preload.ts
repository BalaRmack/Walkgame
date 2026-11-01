/**
 * Preload-скрипт оболочки Noir Browser.
 * Единственный мост между renderer'ом и main-процессом: безопасно экспонирует
 * узкий API window.noir при включённых contextIsolation и sandbox.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { NoirApi, TabsState, AdblockStatus, AiEvent, AiSettings } from '../shared/protocol';

const api: NoirApi = {
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  createTab: (url?: string) => ipcRenderer.invoke('tabs:create', url),
  closeTab: (id: number) => ipcRenderer.invoke('tabs:close', id),
  activateTab: (id: number) => ipcRenderer.invoke('tabs:activate', id),

  navigate: (input: string) => ipcRenderer.invoke('nav:go', input),
  goBack: () => ipcRenderer.invoke('nav:back'),
  goForward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),
  goHome: () => ipcRenderer.invoke('nav:home'),
  stop: () => ipcRenderer.invoke('nav:stop'),

  setSidebarOpen: (open: boolean) => ipcRenderer.invoke('layout:sidebar', open),

  setAdblockEnabled: (enabled: boolean) => ipcRenderer.invoke('adblock:set-enabled', enabled),
  getAdblockStatus: () => ipcRenderer.invoke('adblock:get-status'),

  runAiCommand: (command: string, settings: AiSettings) =>
    ipcRenderer.invoke('ai:command', command, settings),
  cancelAi: () => ipcRenderer.invoke('ai:cancel'),

  onTabsState: (cb: (s: TabsState) => void) => {
    ipcRenderer.on('tabs:state', (_e, state: TabsState) => cb(state));
  },
  onAdblockStatus: (cb: (s: AdblockStatus) => void) => {
    ipcRenderer.on('adblock:status', (_e, status: AdblockStatus) => cb(status));
  },
  onAiEvent: (cb: (e: AiEvent) => void) => {
    ipcRenderer.on('ai:event', (_e, event: AiEvent) => cb(event));
  },
  onFocusOmnibox: (cb: () => void) => {
    ipcRenderer.on('ui:focus-omnibox', () => cb());
  },
};

contextBridge.exposeInMainWorld('noir', api);
