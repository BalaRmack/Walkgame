/**
 * Предустановленный блокировщик рекламы Noir Shields.
 *
 * Движок — @ghostery/adblocker-electron: совместим со списками EasyList
 * и синтаксисом uBlock Origin, фильтрует сетевые запросы и применяет
 * косметические фильтры на уровне Electron-сессии. Пользователю не нужно
 * ставить никаких расширений — работает «из коробки» для всех вкладок.
 *
 * Движок скачивается один раз (готовые списки Ghostery CDN) и кэшируется
 * в userData/engine.bin, поэтому последующие запуски мгновенные и офлайн.
 */
import { app, ipcMain, session } from 'electron';
import type { BrowserWindow } from 'electron';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import fetch from 'cross-fetch';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { AdblockStatus } from '../shared/protocol';

let blocker: ElectronBlocker | null = null;
let enabled = true;
let ready = false;
let blockedTotal = 0;
let broadcastTimer: NodeJS.Timeout | null = null;
let getWindowRef: (() => BrowserWindow | null) | null = null;

function status(): AdblockStatus {
  return { enabled, ready, blockedTotal };
}

function broadcast(): void {
  getWindowRef?.()?.webContents.send('adblock:status', status());
}

/** Троттлинг: при шквале заблокированных запросов не спамим IPC. */
function broadcastSoon(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcast();
  }, 400);
}

function prefsPath(): string {
  return path.join(app.getPath('userData'), 'noir-prefs.json');
}

async function loadEnabledPref(): Promise<boolean> {
  try {
    const raw = await fs.readFile(prefsPath(), 'utf-8');
    const prefs = JSON.parse(raw) as { adblockEnabled?: boolean };
    return prefs.adblockEnabled !== false;
  } catch {
    return true; // по умолчанию блокировщик включён
  }
}

async function saveEnabledPref(value: boolean): Promise<void> {
  try {
    await fs.writeFile(prefsPath(), JSON.stringify({ adblockEnabled: value }), 'utf-8');
  } catch {
    /* не критично */
  }
}

function applyToSession(): void {
  if (!blocker) return;
  try {
    if (enabled && !blocker.isBlockingEnabled(session.defaultSession)) {
      blocker.enableBlockingInSession(session.defaultSession);
    } else if (!enabled && blocker.isBlockingEnabled(session.defaultSession)) {
      blocker.disableBlockingInSession(session.defaultSession);
    }
  } catch (err) {
    console.error('[noir-adblock] applyToSession failed:', err);
  }
}

async function loadEngine(): Promise<void> {
  const enginePath = path.join(app.getPath('userData'), 'engine.bin');
  try {
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: enginePath,
      read: fs.readFile,
      write: fs.writeFile,
    });
    blocker.on('request-blocked', () => {
      blockedTotal += 1;
      broadcastSoon();
    });
    blocker.on('request-redirected', () => {
      blockedTotal += 1;
      broadcastSoon();
    });
    ready = true;
    applyToSession();
    console.log('[noir-adblock] engine ready');
  } catch (err) {
    // Первая загрузка без интернета и т.п. — браузер продолжает работать,
    // повторим попытку позже.
    ready = false;
    console.warn('[noir-adblock] engine load failed, retry in 30s:', err);
    setTimeout(() => void loadEngine(), 30_000);
  } finally {
    broadcast();
  }
}

export function initAdblocker(getWindow: () => BrowserWindow | null): void {
  getWindowRef = getWindow;

  ipcMain.handle('adblock:get-status', () => status());
  ipcMain.handle('adblock:set-enabled', async (_e, value: boolean) => {
    enabled = value;
    applyToSession();
    await saveEnabledPref(value);
    broadcast();
    return status();
  });

  void (async () => {
    enabled = await loadEnabledPref();
    broadcast();
    await loadEngine();
  })();
}
