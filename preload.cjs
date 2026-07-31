const { ipcRenderer } = require('electron');

// --- XHR interception (EXACT copy from Lume IDE's kusini-preload.cjs) ---
(function patchXHR() {
  const OrigXHR = window.XMLHttpRequest;

  window.XMLHttpRequest = function PatchedXHR() {
    const xhr = new OrigXHR();
    let isChat = false;
    let lastOffset = 0;
    let lineBuf = '';
    let activeFragmentType = 'RESPONSE';
    let progressListenerAdded = false;
    const origOpen = xhr.open.bind(xhr);
    const origSend = xhr.send.bind(xhr);

    xhr.open = function (method, url, ...rest) {
      isChat = typeof url === 'string' && url.includes('/api/v0/chat/completion');
      if (isChat) console.log('[xhr-patch] open:', url.slice(0, 80));
      return origOpen(method, url, ...rest);
    };

    xhr.send = function (body) {
      if (!isChat) return origSend(body);
      if (progressListenerAdded) {
        console.warn('[xhr-patch] send called again on same xhr, skipping listener re-add');
        return origSend(body);
      }
      progressListenerAdded = true;
      lastOffset = 0;
      lineBuf = '';
      activeFragmentType = 'RESPONSE';
      console.log('[xhr-patch] send on chat URL, adding listeners');

      function handleLine(line) {
        const t = line.trim();
        if (!t) return;
        if (t.startsWith('event: ')) return;
        if (!t.startsWith('data: ')) return;
        const payload = t.slice(6);
        if (payload === '[DONE]' || payload === 'FINISHED') return;

        try {
          const parsed = JSON.parse(payload);
          let content = '';

          const delta = parsed?.choices?.[0]?.delta;
          if (delta) {
            if (typeof delta.content === 'string') content += delta.content;
          } else if (typeof parsed.p === 'string' && parsed.p.includes('fragments')) {
            if (parsed.o === 'APPEND' && Array.isArray(parsed.v)) {
              for (const frag of parsed.v) {
                if (frag.type === 'THINK' || frag.type === 'THINKING') activeFragmentType = 'THINK';
                else if (frag.type === 'RESPONSE') activeFragmentType = 'RESPONSE';
                if (typeof frag.content === 'string' && frag.content) {
                  if (activeFragmentType === 'RESPONSE') content += frag.content;
                }
              }
            } else if (typeof parsed.v === 'string' && parsed.v) {
              if (activeFragmentType === 'RESPONSE') content += parsed.v;
            }
          } else if (typeof parsed.v === 'string' && parsed.v && parsed.v !== 'FINISHED') {
            if (activeFragmentType === 'RESPONSE') content += parsed.v;
          } else if (parsed.v && typeof parsed.v === 'object' && !Array.isArray(parsed.v)) {
            const resp = parsed.v?.response;
            if (resp && !resp.has_pending_fragment) {
              for (const frag of (resp.fragments ?? [])) {
                if (frag.type === 'THINK' || frag.type === 'THINKING') activeFragmentType = 'THINK';
                else if (frag.type === 'RESPONSE') activeFragmentType = 'RESPONSE';
                if (typeof frag.content === 'string') {
                  if (activeFragmentType === 'RESPONSE') content += frag.content;
                }
              }
            }
          } else if (Array.isArray(parsed.v)) {
            for (const op of parsed.v) {
              if (op.p !== 'fragments' || op.o !== 'BATCH') continue;
              for (const bop of (op.v ?? [])) {
                if (bop.o !== 'APPEND') continue;
                for (const frag of (bop.v ?? [])) {
                  if (frag.type === 'THINK' || frag.type === 'THINKING') activeFragmentType = 'THINK';
                  else if (frag.type === 'RESPONSE') activeFragmentType = 'RESPONSE';
                  if (typeof frag.content === 'string') {
                    if (activeFragmentType === 'RESPONSE') content += frag.content;
                  }
                }
              }
            }
          }

          if (content) {
            ipcRenderer.send('bridge:chunk', content);
          }
        } catch (e) { }
      }

      function drain() {
        const raw = xhr.responseText || '';
        const chunk = raw.slice(lastOffset);
        lastOffset = raw.length;
        if (!chunk) return;
        lineBuf += chunk;
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          handleLine(lineBuf.slice(0, idx));
          lineBuf = lineBuf.slice(idx + 1);
        }
      }

      xhr.addEventListener('progress', () => {
        drain();
      });

      xhr.addEventListener('load', () => {
        // Final bytes can land in responseText only at load time, with no
        // progress event covering them. Re-read before flushing so the last
        // token is never stranded in the buffer.
        drain();
        const raw = xhr.responseText || '';
        if (lineBuf.trim()) handleLine(lineBuf);
        lineBuf = '';
        ipcRenderer.send('bridge:diag', { rawLen: raw.length, rawTail: raw.slice(-80) });
        ipcRenderer.send('bridge:done');
      });

      xhr.addEventListener('error', () => {
        drain();
        if (lineBuf.trim()) handleLine(lineBuf);
        lineBuf = '';
        ipcRenderer.send('bridge:done');
      });

      return origSend(body);
    };

    return xhr;
  };

  window.XMLHttpRequest.prototype = OrigXHR.prototype;
  window.XMLHttpRequest.UNSENT = OrigXHR.UNSENT;
  window.XMLHttpRequest.OPENED = OrigXHR.OPENED;
  window.XMLHttpRequest.HEADERS_RECEIVED = OrigXHR.HEADERS_RECEIVED;
  window.XMLHttpRequest.LOADING = OrigXHR.LOADING;
  window.XMLHttpRequest.DONE = OrigXHR.DONE;

  console.log('[preload] XHR patch installed');
})();

// --- Send prompt (exact copy of Lume IDE's DeepSeekHandler.send()) ---
const TEXTAREA_SEL = 'textarea[placeholder="Message DeepSeek"]';
const SEND_BTN_SEL = 'div[role="button"]:not([aria-disabled="true"])';
const TOGGLE_SEL = '[class*="ds-toggle-button"]';
const SEND_DELAY_MS = 300;
const ELEMENT_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitFor(selector, timeout) {
  timeout = timeout || ELEMENT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - start >= timeout) reject(new Error('Timeout for ' + selector));
      else setTimeout(check, RETRY_DELAY_MS);
    };
    check();
  });
}

function sendEnter(textarea) {
  ['keydown', 'keypress', 'keyup'].forEach(function(type) {
    textarea.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    }));
  });
}

function disableSearch() {
  var btns = document.querySelectorAll(TOGGLE_SEL);
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].textContent.trim().includes('Search') && btns[i].classList.contains('ds-toggle-button--selected')) {
      btns[i].click();
      break;
    }
  }
}

var busy = false;
var lastHash = '';

async function send(prompt) {
  if (busy) {
    var hash = prompt.slice(0, 100);
    if (hash === lastHash) return;
  }

  busy = true;
  lastHash = prompt.slice(0, 100);

  try {
    var ta = await waitFor(TEXTAREA_SEL);

    disableSearch();

    var native = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (native && native.set) native.set.call(ta, prompt);
    else ta.value = prompt;

    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.focus();

    await sleep(SEND_DELAY_MS);

    sendEnter(ta);

    busy = false;
  } catch (err) {
    ipcRenderer.send('bridge:error', err.message);
    busy = false;
  }
}

// --- IPC ---
ipcRenderer.on('bridge:send-prompt', function(_event, text) {
  send(text);
});

// --- Init ---
window.addEventListener('load', function() {
  setTimeout(async function() {
    try {
      await waitFor(TEXTAREA_SEL, 15000);
      console.log('[preload] DeepSeek UI ready');
      ipcRenderer.send('bridge:ready');
    } catch {
      console.log('[preload] UI not found, retrying...');
      setTimeout(async function() {
        try {
          await waitFor(TEXTAREA_SEL, 15000);
          ipcRenderer.send('bridge:ready');
        } catch {
          ipcRenderer.send('bridge:error', 'DeepSeek UI not detected');
        }
      }, 5000);
    }
  }, 2000);
});