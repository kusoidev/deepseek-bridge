import { IpcRenderer } from 'electron';

/** CSS selector for the DeepSeek chat textarea. */
const TEXTAREA_SEL = 'textarea[placeholder="Message DeepSeek"]';

/** CSS selector for the search/deep-think toggle buttons. */
const TOGGLE_SEL = '[class*="ds-toggle-button"]';

/** Milliseconds to wait after typing before dispatching Enter. */
const SEND_DELAY_MS = 300;

/** Maximum time to poll for an element before giving up. */
const ELEMENT_TIMEOUT_MS = 8000;

/** Interval between element existence checks. */
const RETRY_DELAY_MS = 500;

/** Whether a prompt send is currently in progress. */
let busy = false;

/** Hash of the last prompt (first 100 chars), used for duplicate detection. */
let lastHash = '';

/**
 * Promise-based setTimeout.
 *
 * @param ms - Milliseconds to sleep.
 * @returns A promise that resolves after the given delay.
 */
function Sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll for a DOM element until it appears or the timeout expires.
 *
 * Checks every RETRY_DELAY_MS (500ms) up to the given timeout.
 *
 * @param selector - CSS selector to query.
 * @param timeout - Maximum time to wait in milliseconds. Defaults to ELEMENT_TIMEOUT_MS (8000).
 * @returns A promise that resolves with the found element.
 * @throws Error if the element doesn't appear within the timeout.
 *
 * @example
 * const ta = await WaitFor('textarea[placeholder="Message DeepSeek"]');
 */
function WaitFor(selector: string, timeout = ELEMENT_TIMEOUT_MS): Promise<Element> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - start >= timeout) reject(new Error(`Timeout for ${selector}`));
      else setTimeout(check, RETRY_DELAY_MS);
    };
    check();
  });
}

/**
 * Dispatch keyboard Enter key events on the textarea to submit the prompt.
 *
 * Dispatches all three key event phases (keydown, keypress, keyup) because
 * DeepSeek's React event handlers may listen to any combination. All three
 * are sent with keyCode 13, code 'Enter', bubbles true.
 *
 * @param textarea - The textarea element to dispatch events on.
 */
function SendEnter(textarea: HTMLTextAreaElement): void {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    textarea.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    }));
  }
}

/**
 * Turn off the Search toggle if it's currently active.
 *
 * DeepSeek has toggle buttons that switch between Search and DeepThink
 * modes. Search mode must be off for regular chat prompts to work
 * correctly. This function finds the toggle containing "Search" text
 * that is in the selected state and clicks it to disable Search.
 */
function DisableSearch(): void {
  const btns = document.querySelectorAll(TOGGLE_SEL);
  for (let i = 0; i < btns.length; i++) {
    const btn = btns[i];
    if (btn.textContent && btn.textContent.trim().includes('Search')
        && btn.classList.contains('ds-toggle-button--selected')) {
      (btn as HTMLElement).click();
      break;
    }
  }
}

/**
 * Enable the DeepThink toggle if it's not already active.
 *
 * DeepSeek's DeepThink mode produces better reasoning and tool-use
 * behavior. This function finds the toggle containing "DeepThink" text
 * that is NOT currently selected and clicks it to activate the mode.
 * If it's already on, nothing happens.
 */
function EnableDeepThink(): void {
  const btns = document.querySelectorAll(TOGGLE_SEL);
  for (let i = 0; i < btns.length; i++) {
    const btn = btns[i];
    if (btn.textContent && btn.textContent.trim().includes('DeepThink')
        && !btn.classList.contains('ds-toggle-button--selected')) {
      (btn as HTMLElement).click();
      break;
    }
  }
}

/**
 * Type a prompt into the DeepSeek web UI textarea and submit it.
 *
 * Uses the native value setter (Object.getOwnPropertyDescriptor) to set
 * the textarea value so React's synthetic event system detects the change.
 * Dispatches 'input' and 'change' events, then waits SEND_DELAY_MS before
 * dispatching keyboard Enter events.
 *
 * Guarded against concurrent calls: if a send is in progress and the
 * new prompt's first 100 chars match the in-flight prompt, the call
 * is silently skipped. This prevents duplicate sends from the queue.
 *
 * Search mode is disabled and DeepThink mode is enabled before sending.
 *
 * @param prompt - The full text to type into the textarea.
 * @param ipc - Electron IPC renderer for sending error messages.
 *
 * @example
 * await SendPrompt('What is the capital of France?', ipcRenderer);
 */
export async function SendPrompt(prompt: string, ipc: IpcRenderer): Promise<void> {
  if (busy) {
    const hash = prompt.slice(0, 100);
    if (hash === lastHash) return;
  }
  busy = true;
  lastHash = prompt.slice(0, 100);

  try {
    const ta = await WaitFor(TEXTAREA_SEL) as HTMLTextAreaElement;

    DisableSearch();
    EnableDeepThink();

    const native = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (native && native.set) native.set.call(ta, prompt);
    else ta.value = prompt;

    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.focus();

    await Sleep(SEND_DELAY_MS);

    SendEnter(ta);
    busy = false;
  } catch (err) {
    ipc.send('bridge:error', (err as Error).message);
    busy = false;
  }
}

/**
 * Wait for the DeepSeek chat UI to become ready and signal the main process.
 *
 * Called after the page loads. Attempts to find the chat textarea with a
 * 15-second timeout. If not found on the first try, waits 5 seconds and
 * retries once more. On success, sends 'bridge:ready' over IPC after
 * enabling DeepThink. On final failure, sends 'bridge:error'.
 *
 * @param ipc - Electron IPC renderer for signaling readiness or error.
 *
 * @example
 * window.addEventListener('load', () => {
 *   setTimeout(() => WaitForReady(ipcRenderer), 2000);
 * });
 */
export async function WaitForReady(ipc: IpcRenderer): Promise<void> {
  const waitAndSignal = async (timeout: number) => {
    try {
      await WaitFor(TEXTAREA_SEL, timeout);
      EnableDeepThink();
      console.log('[preload] DeepSeek UI ready');
      ipc.send('bridge:ready');
      return true;
    } catch {
      return false;
    }
  };

  const ok = await waitAndSignal(15000);
  if (!ok) {
    console.log('[preload] UI not found, retrying...');
    await Sleep(5000);
    const ok2 = await waitAndSignal(15000);
    if (!ok2) {
      ipc.send('bridge:error', 'DeepSeek UI not detected');
    }
  }
}