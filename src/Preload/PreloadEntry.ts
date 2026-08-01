import { ipcRenderer } from 'electron';
import { InstallXhrPatch } from './XhrPatch';
import { SendPrompt, WaitForReady } from './DeepSeekUi';

/**
 * Preload script entry point.
 *
 * Runs in the DeepSeek BrowserWindow renderer process with nodeIntegration: true
 * and contextIsolation: false. Performs three tasks:
 *
 * 1. Installs the XMLHttpRequest monkey-patch so all chat streaming responses
 *    are intercepted and relayed to the main process as bridge:chunk messages.
 *
 * 2. Listens for bridge:send-prompt IPC messages from the main process. Each
 *    message carries the full text to type into the DeepSeek textarea.
 *
 * 3. After the window 'load' event fires, waits 2 seconds for React to hydrate,
 *    then starts polling for the textarea. When found, signals bridge:ready
 *    so the main process can begin processing queued API requests.
 */

InstallXhrPatch(ipcRenderer);

ipcRenderer.on('bridge:send-prompt', (_event, text: string) => {
  SendPrompt(text, ipcRenderer);
});

window.addEventListener('load', () => {
  setTimeout(() => WaitForReady(ipcRenderer), 2000);
});