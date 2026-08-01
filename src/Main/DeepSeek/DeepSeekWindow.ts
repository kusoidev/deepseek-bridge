import { BrowserWindow, ipcMain, app } from 'electron';
import * as path from 'path';
import { DEEPSEEK_URL } from '../App/Constants';
import { State } from '../App/State';
import { ProcessQueue } from '../Server/RequestQueue';
import { FinishStream, FlushStream, EmitThinking } from './StreamHandler';

/**
 * Create the Electron BrowserWindow that hosts chat.deepseek.com.
 *
 * Configures the window with the preload script, disables background
 * throttling (so streaming works when hidden), and wires up lifecycle:
 * - On 'did-finish-load': start polling CheckReady after 2s.
 * - On 'close': if ready, hide to tray instead of closing.
 * - On 'closed': if not ready, quit the app.
 *
 * @returns The created BrowserWindow instance.
 */
export function CreateDeepSeekWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, '..', '..', 'Preload', 'PreloadEntry.js');
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    title: 'DeepSeek Bridge',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: false,
      nodeIntegration: true,
    },
  });
  win.loadURL(DEEPSEEK_URL);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('did-finish-load', () => { setTimeout(CheckReady, 2000); });
  win.on('close', (e) => {
    if (State.deepseekReady) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => {
    State.deepseekWindow = null;
    if (!State.deepseekReady) { app.quit(); }
  });
  return win;
}

/**
 * Poll the DeepSeek page until the chat textarea is visible.
 *
 * Executes a JavaScript snippet in the renderer that checks for a textarea
 * and confirms the URL doesn't contain /sign or /login (logged-out state).
 * Retries every 3 seconds until success. On first success, hides the window
 * and starts processing the request queue.
 */
function CheckReady(): void {
  if (!State.deepseekWindow || State.deepseekWindow.isDestroyed()) return;
  State.deepseekWindow.webContents.executeJavaScript(`
    (function() {
      var ta = document.querySelector('textarea');
      return !!(ta && !window.location.href.includes('/sign') && !window.location.href.includes('/login'));
    })()
  `).then((ready: boolean) => {
    if (ready && !State.deepseekReady) {
      State.deepseekReady = true;
      if (State.deepseekWindow && !State.deepseekWindow.isDestroyed()) State.deepseekWindow.hide();
      ProcessQueue();
    } else if (!ready) {
      setTimeout(CheckReady, 3000);
    }
  }).catch(() => { setTimeout(CheckReady, 3000); });
}

/**
 * Register all IPC handlers for communication with the preload script.
 *
 * Four channels:
 * - **bridge:ready**: Preload detected the DeepSeek textarea. Hide window, start queue.
 * - **bridge:chunk**: A text token arrived from the XHR stream. Accumulate and
 *   start the 50ms flush timer if not already running.
 * - **bridge:done**: The XHR stream finished. Call FinishStream.
 * - **bridge:error**: The XHR or UI threw an error. Call FinishStream with the message.
 * - **bridge:diag**: Diagnostic info (raw response length, tail bytes). Logged.
 */
export function RegisterIpcHandlers(): void {
  ipcMain.on('bridge:ready', () => {
    State.deepseekReady = true;
    if (State.deepseekWindow && !State.deepseekWindow.isDestroyed()) State.deepseekWindow.hide();
    ProcessQueue();
  });

  ipcMain.on('bridge:chunk', (_e, text: string) => {
    if (!State.currentStreamRes || State.streamDone) return;
    State.fullResponseText += text;
    State.streamBuffer += text;
    if (!State.streamTimer) {
      State.streamTimer = setInterval(() => {
        FlushStream();
        if (State.streamDone && State.streamTimer) {
          clearInterval(State.streamTimer);
          State.streamTimer = null;
        }
      }, 50);
    }
  });

  ipcMain.on('bridge:thinking', (_e, text: string) => {
    if (!State.currentStreamRes || State.streamDone) return;
    EmitThinking(text);
  });

  ipcMain.on('bridge:done', () => { FinishStream(); });
  ipcMain.on('bridge:error', (_e, err: string) => { FinishStream(err); });
  ipcMain.on('bridge:diag', (_e, d: { rawLen: number; rawTail: string }) => {
    console.log(`[bridge:diag] rawLen=${d && d.rawLen} rawTail=${JSON.stringify(d && d.rawTail)}`);
  });
}