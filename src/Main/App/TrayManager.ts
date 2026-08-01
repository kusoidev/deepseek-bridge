import { app, Tray, Menu, nativeImage } from 'electron';
import { State } from './State';
import { CreateDeepSeekWindow } from '../DeepSeek/DeepSeekWindow';

/**
 * Create the macOS system tray icon with a context menu.
 *
 * The tray shows the current bridge status, a 'Show Window' option that
 * reveals the hidden DeepSeek BrowserWindow (or recreates it if destroyed),
 * and a Quit button that calls app.exit(0).
 *
 * The tray icon is a minimal 1x1 pixel PNG encoded as a data URL and
 * resized to 16x16. macOS renders it as a small dot in the menu bar.
 */
export function CreateTray(): void {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwAB/wH+1YsHXQAAAABJRU5ErkJggg==',
  );
  State.tray = new Tray(icon.resize({ width: 16, height: 16 }));
  State.tray.setToolTip('DeepSeek Bridge');
  State.tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `Status: ${State.deepseekReady ? 'Ready' : 'Loading...'}`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Show Window',
        click: () => {
          if (!State.deepseekWindow || State.deepseekWindow.isDestroyed()) {
            State.deepseekWindow = CreateDeepSeekWindow();
          } else {
            State.deepseekWindow.show();
            State.deepseekWindow.focus();
          }
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.exit(0) },
    ]),
  );
}