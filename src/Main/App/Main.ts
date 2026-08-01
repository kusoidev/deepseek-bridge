import { app } from 'electron';
import { CreateDeepSeekWindow, RegisterIpcHandlers } from '../DeepSeek/DeepSeekWindow';
import { StartServer } from '../Server/ApiServer';
import { CreateTray } from './TrayManager';
import { State } from './State';

/**
 * Electron app entry point.
 *
 * On ready: create the DeepSeek window, register IPC handlers, start
 * the Express API server, and create the system tray.
 *
 * Lifecycle:
 * - window-all-closed: no-op (app stays alive in tray).
 * - before-quit: destroy the window and tray.
 * - activate: show or recreate the window (macOS dock click).
 */
app.whenReady().then(() => {
  State.deepseekWindow = CreateDeepSeekWindow();
  RegisterIpcHandlers();
  StartServer();
  CreateTray();
});

app.on('window-all-closed', () => { });

app.on('before-quit', () => {
  if (State.deepseekWindow && !State.deepseekWindow.isDestroyed()) {
    State.deepseekWindow.destroy();
  }
  if (State.tray) {
    State.tray.destroy();
    State.tray = null;
  }
});

app.on('activate', () => {
  if (!State.deepseekWindow || State.deepseekWindow.isDestroyed()) {
    State.deepseekWindow = CreateDeepSeekWindow();
  } else {
    State.deepseekWindow.show();
  }
});